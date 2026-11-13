import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const INDEX_FILENAME = "index.json";
const writeLocks = new Map();

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { __error: error.message };
  }
}

function relativePosix(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

async function loadPointer(root, name) {
  const pointer = await readJsonIfPresent(path.join(root, "artifacts", name));
  if (!pointer || pointer.__error) {
    return pointer?.__error ? { error: pointer.__error } : null;
  }
  return {
    runId: pointer.runId || null,
    scenario: pointer.scenario || null,
    status: pointer.status || null,
    result: pointer.result || null,
  };
}

async function summarizeRunDirectory(root, runDirectoryName) {
  const runDirectory = path.join(root, "artifacts", runDirectoryName);
  const resultPath = path.join(runDirectory, "result.json");
  const result = await readJsonIfPresent(resultPath);
  if (!result || result.__error) {
    return {
      runId: runDirectoryName,
      path: relativePosix(root, runDirectory),
      status: result?.__error ? "unreadable" : "incomplete",
      error: result?.__error || "result.json missing",
      artifacts: {
        result: null,
        contactSheet: null,
        screenshots: 0,
        stateLog: await pathExists(path.join(runDirectory, "state.jsonl")) ? "state.jsonl" : null,
        appLog: await pathExists(path.join(runDirectory, "app.log")) ? "app.log" : null,
      },
    };
  }

  const screenshots = Array.isArray(result.artifacts?.screenshots) ? result.artifacts.screenshots.length : 0;
  return {
    runId: result.runId || runDirectoryName,
    path: relativePosix(root, runDirectory),
    scenario: result.scenario?.name || null,
    scenarioPath: result.scenario?.path || null,
    status: result.status || "unknown",
    startedAt: result.startedAt || null,
    finishedAt: result.finishedAt || null,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
    counts: result.counts || null,
    error: result.error || null,
    git: result.git || null,
    artifacts: {
      result: "result.json",
      contactSheet: result.artifacts?.contactSheet || null,
      screenshots,
      stateLog: result.artifacts?.stateLog || (await pathExists(path.join(runDirectory, "state.jsonl")) ? "state.jsonl" : null),
      appLog: result.artifacts?.appLog || (await pathExists(path.join(runDirectory, "app.log")) ? "app.log" : null),
    },
  };
}

async function buildRunIndex(root) {
  const artifactsRoot = path.join(root, "artifacts");
  const runs = [];
  let probe = null;

  if (await pathExists(artifactsRoot)) {
    const entries = await readdir(artifactsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "probe") {
        const probeDir = path.join(artifactsRoot, "probe");
        probe = {
          path: "artifacts/probe",
          hasAppLog: await pathExists(path.join(probeDir, "app.log")),
        };
        continue;
      }
      if (entry.name === "handoffs" || entry.name.startsWith(".")) continue;
      runs.push(await summarizeRunDirectory(root, entry.name));
    }
  }

  runs.sort((left, right) => {
    const leftTime = Date.parse(left.finishedAt || left.startedAt || "") || 0;
    const rightTime = Date.parse(right.finishedAt || right.startedAt || "") || 0;
    return rightTime - leftTime;
  });

  const lastRun = await loadPointer(root, "last-run.json");
  const lastGreen = await loadPointer(root, "last-green.json");

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    root,
    pointers: {
      lastRun,
      lastGreen,
      probe,
    },
    summary: {
      runCount: runs.length,
      passed: runs.filter((run) => run.status === "passed").length,
      failed: runs.filter((run) => run.status === "failed").length,
      incomplete: runs.filter((run) => run.status === "incomplete" || run.status === "unreadable").length,
    },
    runs,
  };
}

async function writeRunIndex(root, index = null) {
  const artifactsRoot = path.resolve(root, "artifacts");
  const lockKey = artifactsRoot;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const previous = writeLocks.get(lockKey) || Promise.resolve();
  const tail = previous.catch(() => {}).then(() => gate);
  writeLocks.set(lockKey, tail);
  try {
    await previous;
    await mkdir(artifactsRoot, { recursive: true });
    const payload = index || await buildRunIndex(root);
    const temporaryPath = path.join(
      artifactsRoot,
      `.${INDEX_FILENAME}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
    const indexPath = path.join(artifactsRoot, INDEX_FILENAME);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`);
      await rename(temporaryPath, indexPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
    return {
      ...payload,
      indexPath: relativePosix(root, indexPath),
    };
  } finally {
    release();
    if (writeLocks.get(lockKey) === tail) writeLocks.delete(lockKey);
  }
}

async function readRunIndex(root) {
  const indexPath = path.join(root, "artifacts", INDEX_FILENAME);
  const existing = await readJsonIfPresent(indexPath);
  if (!existing || existing.__error) {
    return {
      exists: false,
      path: relativePosix(root, indexPath),
      error: existing?.__error || null,
      index: null,
    };
  }
  return {
    exists: true,
    path: relativePosix(root, indexPath),
    error: null,
    index: existing,
  };
}

function formatRunIndex(index) {
  const lines = [
    `Run index: ${index.summary.runCount} runs` +
      ` (${index.summary.passed} passed, ${index.summary.failed} failed, ${index.summary.incomplete} incomplete)`,
    `Generated: ${index.generatedAt}`,
  ];
  if (index.pointers.lastRun) {
    lines.push(`Last run: ${index.pointers.lastRun.runId || "(unknown)"} · ${index.pointers.lastRun.status || "n/a"} · ${index.pointers.lastRun.scenario || "n/a"}`);
  } else {
    lines.push("Last run: none");
  }
  if (index.pointers.lastGreen) {
    lines.push(`Last green: ${index.pointers.lastGreen.runId || "(unknown)"} · ${index.pointers.lastGreen.scenario || "n/a"}`);
  } else {
    lines.push("Last green: none");
  }
  if (index.pointers.probe) {
    lines.push(`Probe artifacts: ${index.pointers.probe.path}${index.pointers.probe.hasAppLog ? " (app.log present)" : ""}`);
  } else {
    lines.push("Probe artifacts: none");
  }
  const preview = index.runs.slice(0, 5);
  if (preview.length) {
    lines.push("Recent runs:");
    for (const run of preview) {
      lines.push(`  - ${run.runId}: ${run.status}${run.scenario ? ` · ${run.scenario}` : ""}${run.artifacts.contactSheet ? " · contact-sheet" : ""}`);
    }
    if (index.runs.length > preview.length) {
      lines.push(`  … ${index.runs.length - preview.length} more in artifacts/index.json`);
    }
  }
  lines.push(`Index file: artifacts/${INDEX_FILENAME}`);
  return lines.join("\n");
}

export {
  INDEX_FILENAME,
  buildRunIndex,
  formatRunIndex,
  readRunIndex,
  writeRunIndex,
};
