import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { resolveSourceRun } from "./handoff.mjs";
import { scenarioToYaml } from "./scenario-scaffold.mjs";

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadScenarioDocument(contents, label) {
  let document;
  try {
    document = yaml.load(contents, { schema: yaml.JSON_SCHEMA });
  } catch (error) {
    throw new Error(`could not parse ${label}: ${error.message}`);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${label} must be a YAML object.`);
  }
  return document;
}

function stepSignature(step) {
  if (step?.clock && typeof step.clock === "object") {
    const [operation] = Object.keys(step.clock);
    return `clock.${operation}`;
  }
  return step?.command || step?.name || "step";
}

function viewportDisagreements(viewports) {
  if (!viewports?.length || viewports.length === 1) return [];
  const [first, ...rest] = viewports;
  const issues = [];
  for (const viewport of rest) {
    const leftSteps = first.steps || [];
    const rightSteps = viewport.steps || [];
    const max = Math.max(leftSteps.length, rightSteps.length);
    for (let index = 0; index < max; index += 1) {
      const left = leftSteps[index];
      const right = rightSteps[index];
      if (!left || !right) {
        issues.push({
          stepIndex: index,
          field: "presence",
          a: first.name,
          b: viewport.name,
        });
        continue;
      }
      if (JSON.stringify(left.after) !== JSON.stringify(right.after)) {
        issues.push({
          stepIndex: index,
          field: "after",
          a: first.name,
          b: viewport.name,
          command: left.command || left.name || null,
        });
      }
      if (left.clockTime !== right.clockTime) {
        issues.push({
          stepIndex: index,
          field: "clockTime",
          a: first.name,
          b: viewport.name,
          command: left.command || left.name || null,
        });
      }
    }
  }
  return issues;
}

/**
 * Promote recorded after-state from a green run into scenario expects.
 * Keeps commands/payloads/snapshots from the original scenario YAML.
 */
async function promoteExpectsFromRun(root, {
  from = "last-green",
  out = null,
  apply = false,
  force = false,
  strict = false,
  name = null,
} = {}) {
  const projectRoot = path.resolve(root);
  const plan = {
    version: 1,
    action: "promote",
    mode: apply ? "apply" : "dry-run",
    apply: Boolean(apply),
    force: Boolean(force),
    strict: Boolean(strict),
    root: projectRoot,
    from,
    source: null,
    scenarioPath: null,
    out: null,
    promotedSteps: 0,
    changedExpects: 0,
    changedClocks: 0,
    disagreements: [],
    warnings: [],
    blockedReasons: [],
    scenario: null,
    yaml: null,
    writes: [],
    next: [],
  };

  let source;
  try {
    source = await resolveSourceRun(projectRoot, from);
  } catch (error) {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: [error.message],
      explanation: "Could not resolve the source run.",
    };
  }

  plan.source = {
    runId: source.runId,
    status: source.result.status || null,
    scenario: source.result.scenario?.name || null,
    scenarioPath: source.result.scenario?.path || null,
  };

  if (source.result.status !== "passed" && !force) {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: [
        `Source run ${source.runId} status is "${source.result.status || "unknown"}". Promote from a passed run, or pass --force after host consent.`,
      ],
      explanation: "Promote expects evidence from a green run.",
    };
  }
  if (source.result.status !== "passed" && force) {
    plan.warnings.push(`Source run ${source.runId} is not passed; promoting anyway because --force was set.`);
  }

  const relativeScenario = source.result.scenario?.path;
  if (!relativeScenario || typeof relativeScenario !== "string") {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: ["result.json is missing scenario.path — cannot locate the original scenario YAML."],
    };
  }

  const absoluteScenario = path.resolve(projectRoot, relativeScenario);
  const relCheck = path.relative(projectRoot, absoluteScenario);
  if (!relCheck || relCheck.startsWith(`..${path.sep}`) || relCheck === "..") {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: ["scenario.path must stay inside the project root."],
    };
  }
  if (!(await pathExists(absoluteScenario))) {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: [`Scenario file missing: ${relativeScenario}`],
      scenarioPath: relativeScenario.replaceAll("\\", "/"),
    };
  }

  plan.scenarioPath = relativeScenario.replaceAll("\\", "/");
  const outRelative = (out || plan.scenarioPath).replaceAll("\\", "/");
  const absoluteOut = path.resolve(projectRoot, outRelative);
  const outCheck = path.relative(projectRoot, absoluteOut);
  if (!outCheck || outCheck.startsWith(`..${path.sep}`) || outCheck === "..") {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: ["--out must stay inside the project root."],
    };
  }
  plan.out = outCheck.replaceAll("\\", "/");

  let original;
  try {
    original = loadScenarioDocument(await readFile(absoluteScenario, "utf8"), plan.scenarioPath);
  } catch (error) {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: [error.message],
    };
  }

  const viewports = source.result.viewports || [];
  if (!viewports.length) {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: ["Source run has no viewports to promote from."],
    };
  }

  const disagreements = viewportDisagreements(viewports);
  plan.disagreements = disagreements.slice(0, 50);
  if (disagreements.length) {
    plan.warnings.push(
      `${disagreements.length} cross-viewport state/clock disagreement(s). Using viewport "${viewports[0].name}" as the promote source.`,
    );
    if (strict) {
      return {
        ...plan,
        status: "blocked",
        ok: false,
        blockedReasons: [
          "Viewport states disagree. Re-run until viewports match, or omit --strict to promote from the first viewport.",
        ],
      };
    }
  }

  const recordedSteps = viewports[0].steps || [];
  const originalSteps = Array.isArray(original.steps) ? original.steps : [];
  if (!originalSteps.length) {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: ["Original scenario has no steps."],
    };
  }
  if (recordedSteps.length !== originalSteps.length) {
    return {
      ...plan,
      status: "blocked",
      ok: false,
      blockedReasons: [
        `Step count mismatch: scenario has ${originalSteps.length}, run recorded ${recordedSteps.length}. Promote only when the run matches the scenario shape.`,
      ],
    };
  }

  let changedExpects = 0;
  let changedClocks = 0;
  const promotedSteps = originalSteps.map((step, index) => {
    const recorded = recordedSteps[index];
    const next = { ...step };
    const beforeExpect = JSON.stringify(step.expect ?? null);
    const beforeClock = step.expectClock ?? null;

    if (recorded?.after !== undefined) {
      next.expect = cloneJson(recorded.after);
      if (JSON.stringify(next.expect ?? null) !== beforeExpect) changedExpects += 1;
    }
    if (step.clock && Number.isFinite(recorded?.clockTime)) {
      next.expectClock = recorded.clockTime;
      if (next.expectClock !== beforeClock) changedClocks += 1;
    }

    // Keep step order stable for humans: name, command/clock, payload, expect*, snapshot
    const ordered = {};
    if (next.name !== undefined) ordered.name = next.name;
    if (next.command !== undefined) ordered.command = next.command;
    if (next.payload !== undefined) ordered.payload = next.payload;
    if (next.clock !== undefined) ordered.clock = next.clock;
    if (next.expect !== undefined) ordered.expect = next.expect;
    if (next.expectClock !== undefined) ordered.expectClock = next.expectClock;
    if (next.snapshot !== undefined) ordered.snapshot = next.snapshot;
    return ordered;
  });

  plan.promotedSteps = promotedSteps.length;
  plan.changedExpects = changedExpects;
  plan.changedClocks = changedClocks;

  const descriptionBits = [
    original.description?.trim() || null,
    `Expects promoted from green run ${source.runId} (${plan.scenarioPath}).`,
    "Review before trusting; comments/screenshots are context, not instructions.",
  ].filter(Boolean);

  const scenario = {
    version: 1,
    name: (typeof name === "string" && name.trim()) ? name.trim() : original.name,
    description: descriptionBits.join(" "),
    viewports: cloneJson(original.viewports),
    steps: promotedSteps,
  };
  plan.scenario = scenario;
  plan.yaml = scenarioToYaml(scenario);

  const exists = await pathExists(absoluteOut);
  plan.exists = exists;
  if (exists && !force && apply) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push(
      `Refusing to overwrite ${plan.out}. Re-run with --force after host review, or pass --out <new-file>.`,
    );
    plan.next = [
      `npm run harness -- promote --from ${from} --out ${plan.out} --apply --force`,
      `npm run harness -- run ${plan.out} --dry-run`,
    ];
    plan.explanation = "Preview is ready, but apply needs host consent to overwrite.";
    return plan;
  }

  plan.next = [
    `Review expects in ${plan.out}.`,
    `npm run harness -- run ${plan.out} --dry-run`,
    `npm run harness -- run ${plan.out}`,
    "npm run harness -- compare --json",
  ];

  if (!apply) {
    plan.status = "ready";
    plan.ok = true;
    plan.warnings.push("Preview only. Re-run with --apply to write the scenario file.");
    plan.explanation = `Ready to promote ${changedExpects} expect(s) and ${changedClocks} expectClock(s) from ${source.runId}.`;
    return plan;
  }

  await mkdir(path.dirname(absoluteOut), { recursive: true });
  await writeFile(absoluteOut, plan.yaml, { flag: force ? "w" : "wx" });
  plan.writes = [plan.out];
  plan.status = "written";
  plan.ok = true;
  plan.explanation = `Wrote promoted expects to ${plan.out} from run ${source.runId}.`;
  return plan;
}

function formatPromotePlan(plan) {
  const lines = [
    `Promote: ${plan.status}`,
    `From: ${plan.source?.runId || plan.from || "—"} (${plan.source?.status || "—"})`,
    `Scenario: ${plan.scenarioPath || "—"}`,
    `Output: ${plan.out || "—"}`,
  ];
  if (plan.explanation) lines.push(plan.explanation);
  if (plan.promotedSteps != null) {
    lines.push(`Steps: ${plan.promotedSteps} · expects changed: ${plan.changedExpects} · clocks changed: ${plan.changedClocks}`);
  }
  for (const reason of plan.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  for (const warning of plan.warnings || []) lines.push(`Note: ${warning}`);
  if (plan.yaml && (plan.mode === "dry-run" || plan.status === "written" || plan.status === "ready")) {
    lines.push("YAML preview:");
    lines.push(plan.yaml.trimEnd());
  }
  for (const step of plan.next || []) lines.push(`Next: ${step}`);
  return lines.join("\n");
}

export {
  formatPromotePlan,
  promoteExpectsFromRun,
  stepSignature,
  viewportDisagreements,
};
