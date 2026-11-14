import path from "node:path";
import { access } from "node:fs/promises";
import { inspectProject, setupProject } from "./project-doctor.mjs";
import { ensureChromium } from "./browser-setup.mjs";
import {
  buildScaffoldScenario,
  writeScaffoldScenario,
} from "./scenario-scaffold.mjs";
import { promoteExpectsFromRun } from "./promote.mjs";

const PHASES = ["doctor", "setup", "browser", "probe", "scaffold", "run", "promote"];

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function phaseIndex(name) {
  const index = PHASES.indexOf(name);
  if (index < 0) throw new Error(`Unknown attach phase: ${name}`);
  return index;
}

function normalizeUntil(until, { apply }) {
  if (until == null || until === "") return apply ? "scaffold" : "probe";
  const value = String(until).trim().toLowerCase();
  if (!PHASES.includes(value)) {
    throw new Error(`--until must be one of: ${PHASES.join(", ")}`);
  }
  return value;
}

function block(plan, stoppedAt, reasons) {
  plan.ok = false;
  plan.status = "blocked";
  plan.stoppedAt = stoppedAt;
  plan.blockedReasons = [...new Set((Array.isArray(reasons) ? reasons : [String(reasons)]).filter(Boolean))];
  plan.next = suggestNext(plan);
  return plan;
}

function finish(plan) {
  if (plan.ok) {
    plan.status = plan.apply ? "applied" : "ready";
    if (!plan.stoppedAt) plan.stoppedAt = plan.until;
  }
  if (!plan.next.length) plan.next = suggestNext(plan);
  return plan;
}

function suggestNext(plan) {
  if (!plan.ok) {
    if (plan.stoppedAt === "browser") {
      return [
        "Ask the host for Chromium consent, then:",
        "npm run harness -- attach --until probe --apply --install-browser --yes",
      ];
    }
    if (plan.stoppedAt === "setup") {
      return [
        "npm run harness -- doctor --json",
        "Review start command/URL, then: npm run harness -- attach --until setup --apply",
      ];
    }
    if (plan.stoppedAt === "probe") {
      return [
        "Implement opt-in window.__harness (docs/control-convention.md, docs/attach-existing.md).",
        "npm run harness -- probe --json",
        "npm run harness -- attach --until scaffold --dry-run",
      ];
    }
    if (plan.stoppedAt === "scaffold") {
      return [
        "Choose --out or pass --force after host consent.",
        "npm run harness -- attach --until scaffold --apply --force",
      ];
    }
    if (plan.stoppedAt === "run") {
      return [
        "Fix scenario/expects, then re-run:",
        `npm run harness -- run ${plan.scenarioPath || "scenarios/smoke.yaml"}`,
      ];
    }
    if (plan.stoppedAt === "promote") {
      return [
        "Need a passed run first:",
        `npm run harness -- run ${plan.scenarioPath || "scenarios/smoke.yaml"}`,
        "npm run harness -- attach --until promote --apply",
      ];
    }
    return ["npm run harness -- doctor --json"];
  }

  if (plan.until === "promote") {
    return [
      `npm run harness -- run ${plan.scenarioPath || "scenarios/smoke.yaml"}`,
      "npm run harness -- compare --json",
      "npm run harness -- serve",
    ];
  }

  const nextIndex = Math.min(phaseIndex(plan.until) + 1, PHASES.length - 1);
  const nextPhase = PHASES[nextIndex];
  const flags = [];
  if (plan.apply || nextIndex >= phaseIndex("scaffold")) flags.push("--apply");
  if (nextIndex >= phaseIndex("browser")) flags.push("--yes");
  return [
    `npm run harness -- attach --until ${nextPhase}${flags.length ? ` ${flags.join(" ")}` : " --dry-run"}`,
  ];
}

/**
 * Orchestrate doctor → setup → browser → probe → scaffold → run → promote.
 * Dependencies probeApp / runScenario / loaders are injected from harness.mjs.
 */
async function runAttach(root, {
  until = null,
  apply = false,
  yes = false,
  force = false,
  installBrowser = false,
  name = null,
  out = null,
  scenario = null,
  from = "last-green",
  strict = false,
  skipDoctor = false,
  probeApp,
  runScenario,
  loadJson,
  validateConfig,
  loadScenario,
  validateScenario,
} = {}) {
  if (typeof probeApp !== "function") throw new Error("attach requires probeApp");
  if (typeof runScenario !== "function") throw new Error("attach requires runScenario");
  if (typeof loadJson !== "function" || typeof validateConfig !== "function") {
    throw new Error("attach requires loadJson and validateConfig");
  }
  if (typeof loadScenario !== "function" || typeof validateScenario !== "function") {
    throw new Error("attach requires loadScenario and validateScenario");
  }

  const projectRoot = path.resolve(root);
  const targetUntil = normalizeUntil(until, { apply });
  const stopAt = phaseIndex(targetUntil);
  const plan = {
    version: 1,
    action: "attach",
    mode: apply ? "apply" : "dry-run",
    root: projectRoot,
    until: targetUntil,
    apply: Boolean(apply),
    yes: Boolean(yes),
    force: Boolean(force),
    installBrowser: Boolean(installBrowser),
    scenarioPath: scenario || null,
    ok: true,
    status: "ready",
    stoppedAt: null,
    blockedReasons: [],
    warnings: [],
    next: [],
    phases: {},
  };

  if (!apply) {
    plan.warnings.push("Dry-run: no config/scenario writes and no Chromium install. Probe may still start the app if config + browser are ready.");
  }

  // —— doctor ——
  if (!skipDoctor && stopAt >= phaseIndex("doctor")) {
    const doctor = await inspectProject(projectRoot);
    plan.phases.doctor = {
      status: "ready",
      ok: true,
      agentAttach: doctor.agentAttach || null,
      controlSurface: doctor.harness?.controlSurface || null,
      configExists: Boolean(doctor.harness?.configExists),
      project: {
        name: doctor.project?.name || null,
        packageManager: doctor.project?.packageManager || null,
        frameworks: doctor.project?.frameworks || [],
      },
      warnings: doctor.warnings || [],
    };
    if (doctor.agentAttach?.controlSurfaceRequired) {
      plan.warnings.push("Control surface missing — probe will fail until window.__harness is implemented.");
    }
  } else {
    plan.phases.doctor = { status: "skipped", ok: true };
  }

  if (stopAt < phaseIndex("setup")) return finish({ ...plan, stoppedAt: "doctor" });

  // —— setup ——
  const setup = await setupProject(projectRoot, { apply });
  plan.phases.setup = setup;
  if (setup.status === "blocked") {
    return block(plan, "setup", setup.warnings?.length ? setup.warnings : ["setup blocked"]);
  }

  if (stopAt < phaseIndex("browser")) return finish({ ...plan, stoppedAt: "setup" });

  // —— browser ——
  const needsLive = stopAt >= phaseIndex("probe");
  let browser;
  if (needsLive || installBrowser) {
    if (!apply && installBrowser) {
      browser = ensureChromium(projectRoot, { yes: false });
      if (browser.ok) {
        plan.phases.browser = browser;
      } else {
        plan.phases.browser = {
          ...browser,
          status: "consent-required",
          explanation: "Dry-run will not install Chromium. Pass --apply --install-browser --yes after host consent.",
        };
        plan.warnings.push("Chromium missing — live probe/scaffold/run phases need --apply --install-browser --yes.");
        if (stopAt >= phaseIndex("probe")) {
          return block(plan, "browser", [plan.phases.browser.explanation]);
        }
      }
    } else {
      browser = ensureChromium(projectRoot, {
        yes: Boolean(yes && (installBrowser || needsLive)),
      });
      plan.phases.browser = browser;
      if (!browser.ok && stopAt >= phaseIndex("probe")) {
        return block(plan, "browser", [browser.explanation || browser.error || "Chromium not ready"]);
      }
    }
  } else {
    plan.phases.browser = { status: "skipped", ok: true };
  }

  if (stopAt < phaseIndex("probe")) return finish({ ...plan, stoppedAt: "browser" });

  // —— probe ——
  const configPath = path.join(projectRoot, "harness.config.json");
  if (!(await pathExists(configPath))) {
    if (!apply) {
      plan.phases.probe = {
        status: "skipped",
        ok: true,
        explanation: "harness.config.json missing — dry-run cannot probe. Apply setup first.",
      };
      plan.warnings.push("harness.config.json missing — re-run with --until setup --apply, then attach --until probe.");
      return finish({ ...plan, stoppedAt: "setup" });
    }
    return block(plan, "probe", ["harness.config.json missing — run attach --until setup --apply first."]);
  }

  let config;
  try {
    config = validateConfig(await loadJson(configPath));
  } catch (error) {
    return block(plan, "probe", [error.message]);
  }

  // Consent for probe's ensureChromium: pass yes only when host consented.
  const probe = await probeApp({
    root: projectRoot,
    config,
    yes: Boolean(apply && yes),
  });
  plan.phases.probe = {
    ok: probe.ok,
    status: probe.status || (probe.ok ? "ready" : "blocked"),
    harness: probe.ok ? {
      version: probe.harness?.version || null,
      commandCount: probe.harness?.commands?.length || 0,
      commands: (probe.harness?.commands || []).map((command) => command.name || command),
      state: probe.harness?.state ?? null,
    } : null,
    error: probe.ok ? null : (probe.error || probe.explanation || "probe failed"),
    resumeWith: probe.resumeWith || null,
  };
  if (!probe.ok) {
    return block(plan, "probe", [plan.phases.probe.error]);
  }

  if (stopAt < phaseIndex("scaffold")) return finish({ ...plan, stoppedAt: "probe" });

  // —— scaffold ——
  const scenarioName = (typeof name === "string" && name.trim()) ? name.trim() : "smoke";
  const draft = buildScaffoldScenario({
    commands: probe.harness.commands,
    initialState: probe.harness.state,
    name: scenarioName,
    projectName: plan.phases.doctor?.project?.name || path.basename(projectRoot),
  });
  const scaffold = await writeScaffoldScenario(projectRoot, draft, {
    out: out || scenario || path.join("scenarios", `${scenarioName}.yaml`),
    apply,
    force,
  });
  plan.phases.scaffold = scaffold;
  plan.scenarioPath = scaffold.out;
  if (scaffold.status === "blocked") {
    return block(plan, "scaffold", scaffold.warnings?.length ? scaffold.warnings : ["scaffold blocked"]);
  }

  if (stopAt < phaseIndex("run")) return finish({ ...plan, stoppedAt: "scaffold" });

  // —— run ——
  if (!apply) {
    plan.phases.run = {
      status: "skipped",
      ok: true,
      explanation: "Dry-run does not execute scenarios. Re-run with --apply --until run.",
    };
    plan.warnings.push("Stopped before run because this is a dry-run.");
    return finish({ ...plan, stoppedAt: "scaffold" });
  }

  const scenarioPath = path.resolve(projectRoot, plan.scenarioPath);
  let scenarioDoc;
  try {
    scenarioDoc = validateScenario(await loadScenario(scenarioPath), plan.scenarioPath);
  } catch (error) {
    return block(plan, "run", [error.message]);
  }

  const runResult = await runScenario({
    root: projectRoot,
    scenarioPath: scenarioPath,
    scenario: scenarioDoc,
    config,
  });
  plan.phases.run = {
    ok: runResult.status === "passed",
    status: runResult.status,
    runId: runResult.runId || null,
    error: runResult.error || null,
  };
  if (runResult.status !== "passed") {
    return block(plan, "run", [runResult.error || `Scenario run status: ${runResult.status}`]);
  }

  if (stopAt < phaseIndex("promote")) return finish({ ...plan, stoppedAt: "run" });

  // —— promote ——
  const promote = await promoteExpectsFromRun(projectRoot, {
    from,
    out: plan.scenarioPath,
    apply: true,
    force: true, // overwriting the scenario we just ran is intentional in attach --until promote
    strict,
  });
  plan.phases.promote = promote;
  if (promote.status === "blocked" || promote.ok === false) {
    return block(plan, "promote", promote.blockedReasons?.length ? promote.blockedReasons : ["promote blocked"]);
  }

  return finish({ ...plan, stoppedAt: "promote" });
}

function formatAttachPlan(plan) {
  const lines = [
    `Attach: ${plan.status}`,
    `Mode: ${plan.mode}`,
    `Until: ${plan.until}`,
    `Stopped: ${plan.stoppedAt || "—"}`,
    `Root: ${plan.root}`,
  ];
  if (plan.scenarioPath) lines.push(`Scenario: ${plan.scenarioPath}`);
  for (const reason of plan.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  for (const warning of plan.warnings || []) lines.push(`Note: ${warning}`);
  for (const [name, phase] of Object.entries(plan.phases || {})) {
    const status = phase?.status || (phase?.ok === false ? "blocked" : "done");
    lines.push(`Phase ${name}: ${status}`);
  }
  for (const step of plan.next || []) lines.push(`Next: ${step}`);
  return lines.join("\n");
}

export {
  PHASES,
  formatAttachPlan,
  normalizeUntil,
  runAttach,
};
