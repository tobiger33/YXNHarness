import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveSourceRun } from "./handoff.mjs";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function valuesEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function summarizeRun(source) {
  const result = source.result || {};
  return {
    runId: source.runId,
    from: source.from,
    path: `artifacts/${source.runId}`,
    status: result.status || null,
    scenario: result.scenario?.name || null,
    scenarioPath: result.scenario?.path || null,
    durationMs: result.durationMs ?? null,
    counts: result.counts || null,
    git: result.git || null,
    finishedAt: result.finishedAt || null,
  };
}

function flattenSteps(result) {
  const rows = [];
  for (const viewport of result.viewports || []) {
    for (const step of viewport.steps || []) {
      rows.push({
        key: `${viewport.name}#${step.index ?? rows.length}:${step.command || step.name || "step"}`,
        viewport: viewport.name,
        index: step.index ?? null,
        command: step.command || null,
        name: step.name || null,
        status: step.status || null,
        after: step.after ?? null,
        before: step.before ?? null,
        clockTime: step.clockTime ?? null,
        screenshot: step.screenshot || null,
        error: step.error || null,
      });
    }
  }
  return rows;
}

async function compareScreenshotBytes(baselineDir, candidateDir, relativePath) {
  try {
    const [left, right] = await Promise.all([
      readFile(path.join(baselineDir, relativePath)),
      readFile(path.join(candidateDir, relativePath)),
    ]);
    return {
      path: relativePath,
      status: left.equals(right) ? "identical" : "changed",
      bytes: { baseline: left.length, candidate: right.length },
    };
  } catch (error) {
    return {
      path: relativePath,
      status: "error",
      error: error.message,
    };
  }
}

/**
 * Compare two harness runs (result.json + screenshots).
 * Default: baseline=last-green, candidate=last-run.
 * Evidence only — no writes, no browser.
 */
async function compareRuns(root, {
  baseline = "last-green",
  against = "last-run",
} = {}) {
  const projectRoot = path.resolve(root);
  const report = {
    version: 1,
    action: "compare",
    root: projectRoot,
    baseline: null,
    candidate: null,
    summary: {
      status: "blocked",
      equal: false,
      stateChanges: 0,
      screenshotChanges: 0,
      screenshotMissing: 0,
      screenshotExtra: 0,
    },
    differences: {
      meta: [],
      states: [],
      screenshots: [],
    },
    blockedReasons: [],
  };

  let baselineSource;
  let candidateSource;
  try {
    baselineSource = await resolveSourceRun(projectRoot, baseline);
  } catch (error) {
    report.blockedReasons.push(`Baseline: ${error.message}`);
    return { ...report, status: "blocked", ok: false };
  }
  try {
    candidateSource = await resolveSourceRun(projectRoot, against);
  } catch (error) {
    report.blockedReasons.push(`Candidate: ${error.message}`);
    report.baseline = summarizeRun(baselineSource);
    return { ...report, status: "blocked", ok: false };
  }

  report.baseline = summarizeRun(baselineSource);
  report.candidate = summarizeRun(candidateSource);

  if (baselineSource.runId === candidateSource.runId) {
    report.summary = {
      status: "equal",
      equal: true,
      stateChanges: 0,
      screenshotChanges: 0,
      screenshotMissing: 0,
      screenshotExtra: 0,
    };
    return {
      ...report,
      status: "equal",
      ok: true,
      explanation: "Baseline and candidate resolve to the same run.",
    };
  }

  const meta = [];
  if (report.baseline.scenario !== report.candidate.scenario) {
    meta.push({
      field: "scenario",
      baseline: report.baseline.scenario,
      candidate: report.candidate.scenario,
    });
  }
  if (report.baseline.status !== report.candidate.status) {
    meta.push({
      field: "status",
      baseline: report.baseline.status,
      candidate: report.candidate.status,
    });
  }
  if (!valuesEqual(report.baseline.counts, report.candidate.counts)) {
    meta.push({
      field: "counts",
      baseline: report.baseline.counts,
      candidate: report.candidate.counts,
    });
  }
  report.differences.meta = meta;

  const baselineSteps = flattenSteps(baselineSource.result);
  const candidateSteps = flattenSteps(candidateSource.result);
  const candidateByKey = new Map(candidateSteps.map((step) => [step.key, step]));
  const seenKeys = new Set();
  const stateDiffs = [];

  for (const left of baselineSteps) {
    seenKeys.add(left.key);
    const right = candidateByKey.get(left.key);
    if (!right) {
      stateDiffs.push({
        key: left.key,
        status: "missing-in-candidate",
        baseline: { command: left.command, after: left.after, status: left.status },
        candidate: null,
      });
      continue;
    }
    if (!valuesEqual(left.after, right.after) || left.status !== right.status) {
      stateDiffs.push({
        key: left.key,
        status: "changed",
        baseline: { command: left.command, after: left.after, status: left.status, clockTime: left.clockTime },
        candidate: { command: right.command, after: right.after, status: right.status, clockTime: right.clockTime },
      });
    }
  }
  for (const right of candidateSteps) {
    if (seenKeys.has(right.key)) continue;
    stateDiffs.push({
      key: right.key,
      status: "extra-in-candidate",
      baseline: null,
      candidate: { command: right.command, after: right.after, status: right.status },
    });
  }
  report.differences.states = stateDiffs.slice(0, 100);

  const baselineShots = new Set(baselineSource.result.artifacts?.screenshots || []);
  const candidateShots = new Set(candidateSource.result.artifacts?.screenshots || []);
  const shared = [...baselineShots].filter((name) => candidateShots.has(name));
  const missing = [...baselineShots].filter((name) => !candidateShots.has(name));
  const extra = [...candidateShots].filter((name) => !baselineShots.has(name));

  const screenshotDiffs = [];
  for (const name of missing) {
    screenshotDiffs.push({ path: name, status: "missing-in-candidate" });
  }
  for (const name of extra) {
    screenshotDiffs.push({ path: name, status: "extra-in-candidate" });
  }
  for (const name of shared) {
    const compared = await compareScreenshotBytes(
      baselineSource.runDirectory,
      candidateSource.runDirectory,
      name,
    );
    if (compared.status !== "identical") screenshotDiffs.push(compared);
  }
  report.differences.screenshots = screenshotDiffs.slice(0, 200);

  const stateChanges = stateDiffs.length;
  const screenshotChanges = screenshotDiffs.filter((entry) => entry.status === "changed" || entry.status === "error").length;
  const screenshotMissing = missing.length;
  const screenshotExtra = extra.length;
  const equal = meta.length === 0 && stateChanges === 0 &&
    screenshotChanges === 0 && screenshotMissing === 0 && screenshotExtra === 0;

  report.summary = {
    status: equal ? "equal" : "changed",
    equal,
    stateChanges,
    screenshotChanges,
    screenshotMissing,
    screenshotExtra,
  };

  return {
    ...report,
    status: equal ? "equal" : "changed",
    ok: equal,
    explanation: equal
      ? `Runs match: ${report.baseline.runId} ≡ ${report.candidate.runId}.`
      : `Runs differ: ${stateChanges} state, ${screenshotChanges} screenshot byte, ${screenshotMissing} missing, ${screenshotExtra} extra.`,
  };
}

function formatCompareReport(report) {
  const lines = [
    `Compare: ${report.status}`,
    `Baseline: ${report.baseline?.runId || "—"} (${report.baseline?.scenario || "—"} · ${report.baseline?.status || "—"})`,
    `Candidate: ${report.candidate?.runId || "—"} (${report.candidate?.scenario || "—"} · ${report.candidate?.status || "—"})`,
  ];
  if (report.explanation) lines.push(report.explanation);
  for (const reason of report.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  if (report.differences?.meta?.length) {
    lines.push("Meta:");
    for (const entry of report.differences.meta) {
      lines.push(`  ${entry.field}: ${JSON.stringify(entry.baseline)} → ${JSON.stringify(entry.candidate)}`);
    }
  }
  if (report.differences?.states?.length) {
    lines.push(`State diffs (${report.summary.stateChanges}):`);
    for (const entry of report.differences.states.slice(0, 20)) {
      lines.push(`  ${entry.status} ${entry.key}`);
    }
    if (report.differences.states.length > 20) {
      lines.push(`  … ${report.differences.states.length - 20} more`);
    }
  }
  if (report.differences?.screenshots?.length) {
    lines.push(`Screenshot diffs (${report.differences.screenshots.length}):`);
    for (const entry of report.differences.screenshots.slice(0, 20)) {
      lines.push(`  ${entry.status} ${entry.path}`);
    }
    if (report.differences.screenshots.length > 20) {
      lines.push(`  … ${report.differences.screenshots.length - 20} more`);
    }
  }
  return lines.join("\n");
}

export {
  compareRuns,
  formatCompareReport,
  stableStringify,
  valuesEqual,
};
