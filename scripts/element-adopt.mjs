import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { collectGit } from "./workspace.mjs";
import { createFeedback, bundleFeedback } from "./feedback.mjs";

const ADOPT_DIR = path.join("artifacts", "element-adopts");

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function normalizeElementEntry(entry) {
  if (typeof entry === "string") {
    const id = entry.trim();
    if (!id) return null;
    return { id, kind: "harness", label: null, sourceBranch: null, sourceCommit: null };
  }
  if (!entry || typeof entry !== "object") return null;
  const id = String(entry.id || entry.elementId || entry.element || "").trim();
  if (!id) return null;
  return {
    id: id.slice(0, 240),
    kind: ["harness", "selector", "path", "label"].includes(entry.kind) ? entry.kind : "harness",
    label: entry.label != null ? String(entry.label).slice(0, 240) : null,
    sourceBranch: entry.sourceBranch != null
      ? String(entry.sourceBranch)
      : (entry.source?.branch != null ? String(entry.source.branch) : null),
    sourceCommit: entry.sourceCommit != null
      ? String(entry.sourceCommit)
      : (entry.source?.commit != null ? String(entry.source.commit) : null),
  };
}

function normalizeElements(elements) {
  const raw = Array.isArray(elements) ? elements : (elements == null ? [] : [elements]);
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    const normalized = normalizeElementEntry(entry);
    if (!normalized) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    out.push(normalized);
  }
  return out;
}

function defaultBody({ element, yours, sourceBranch }) {
  const label = element.label ? ` (${element.label})` : "";
  const from = sourceBranch || element.sourceBranch || "source";
  const into = yours?.branch || "current branch";
  return `Adopt visual element "${element.id}"${label} from ${from} into ${into}.`;
}

function formatElementAdoptPlan(plan) {
  const lines = [
    `Element adopt: ${plan.status}`,
    `Mode: ${plan.mode}`,
    `Yours: ${plan.yours?.branch || "—"} @ ${plan.yours?.shortCommit || plan.yours?.commit || "—"}`,
    `Elements: ${(plan.elements || []).map((item) => item.id).join(", ") || "—"}`,
  ];
  if (plan.sourceBranch) lines.push(`Source branch: ${plan.sourceBranch}`);
  if (plan.explanation) lines.push(plan.explanation);
  for (const reason of plan.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  for (const warning of plan.warnings || []) lines.push(`Note: ${warning}`);
  for (const thread of plan.threads || []) {
    lines.push(`Thread ${thread.threadId}: ${thread.elementId || "—"} · ${thread.status}`);
  }
  if (plan.handoff?.handoffId) lines.push(`Handoff: ${plan.handoff.handoffId}`);
  if (plan.manifestPath) lines.push(`Manifest: ${plan.manifestPath}`);
  for (const step of plan.next || []) lines.push(`Next: ${step}`);
  return lines.join("\n");
}

/**
 * Visual element adopt: create element-scoped feedback threads that record
 * yours vs source identity, optionally bundle into a handoff.
 * Does not rewrite UI or invent product behavior — context for a coding agent.
 */
async function planElementAdopt(root, {
  elements = [],
  body = null,
  route = null,
  viewport = null,
  sourceBranch = null,
  sourceCommit = null,
  apply = false,
  withHandoff = false,
  from = "last-green",
  force = false,
  note = null,
  attachmentIds = null,
} = {}) {
  const projectRoot = path.resolve(root);
  const selected = normalizeElements(elements);
  const git = collectGit(projectRoot);
  const yours = git
    ? {
      branch: git.branch || null,
      commit: git.commit || null,
      shortCommit: git.commit ? String(git.commit).slice(0, 7) : null,
      dirty: git.dirty,
    }
    : null;

  const plan = {
    version: 1,
    action: "element-adopt",
    mode: apply ? "apply" : "dry-run",
    root: projectRoot,
    yours,
    sourceBranch: sourceBranch ? String(sourceBranch).trim() : null,
    sourceCommit: sourceCommit ? String(sourceCommit).trim() : null,
    elements: selected,
    withHandoff: Boolean(withHandoff),
    from: from || "last-green",
    ok: true,
    status: "ready",
    blockedReasons: [],
    warnings: [],
    threads: [],
    handoff: null,
    manifestPath: null,
    adoptId: null,
    explanation: null,
    next: [],
  };

  if (!selected.length) {
    plan.ok = false;
    plan.status = "blocked";
    plan.blockedReasons.push("Provide at least one --element / elements[].id.");
    return plan;
  }

  if (!apply) {
    plan.warnings.push("Dry-run: no feedback threads or handoff will be written.");
  }

  const sharedBody = typeof body === "string" && body.trim() ? body.trim() : null;
  const created = [];

  for (const element of selected) {
    const elementSourceBranch = plan.sourceBranch || element.sourceBranch || null;
    const elementSourceCommit = plan.sourceCommit || element.sourceCommit || null;
    const text = sharedBody || defaultBody({
      element,
      yours,
      sourceBranch: elementSourceBranch,
    });
    const threadPlan = await createFeedback(projectRoot, {
      body: text,
      apply,
      route,
      viewport,
      branch: yours?.branch || null,
      commit: yours?.commit || null,
      attachmentIds,
      element: {
        id: element.id,
        kind: element.kind,
        label: element.label,
      },
      source: {
        branch: elementSourceBranch,
        commit: elementSourceCommit,
        elementId: element.id,
      },
    });
    if (threadPlan.status === "blocked" || threadPlan.ok === false) {
      plan.ok = false;
      plan.status = "blocked";
      plan.blockedReasons.push(
        ...(threadPlan.blockedReasons || [`Failed to create feedback for element ${element.id}.`]),
      );
      return plan;
    }
    created.push({
      elementId: element.id,
      threadId: threadPlan.thread.threadId,
      status: apply ? "open" : "preview",
      scope: threadPlan.thread.scope,
      sourceBranch: elementSourceBranch,
    });
  }

  plan.threads = created;
  plan.explanation = apply
    ? `Created ${created.length} element feedback thread(s) for adopt into ${yours?.branch || "current branch"}.`
    : `Ready to create ${created.length} element feedback thread(s).`;

  if (apply && withHandoff) {
    const bundle = await bundleFeedback(projectRoot, {
      threadIds: created.map((item) => item.threadId),
      from,
      apply: true,
      force,
      note: note || `Element adopt: ${selected.map((item) => item.id).join(", ")}.`,
    });
    if (bundle.status === "blocked" || bundle.ok === false) {
      plan.ok = false;
      plan.status = "blocked";
      plan.blockedReasons.push(
        ...(bundle.blockedReasons || ["Bundling element feedback into a handoff failed."]),
      );
      plan.handoff = bundle.handoff || null;
      plan.warnings.push("Feedback threads were created, but handoff bundle failed.");
      return plan;
    }
    plan.handoff = {
      handoffId: bundle.handoff?.handoffId || bundle.handoffId || null,
      path: bundle.handoff?.path || null,
      status: bundle.status,
    };
    plan.threads = created.map((item) => ({ ...item, status: "bundled" }));
    plan.explanation += plan.handoff.handoffId
      ? ` Bundled into handoff ${plan.handoff.handoffId}.`
      : " Bundled into a handoff.";
  }

  if (apply) {
    const adoptId = newId("eladopt");
    plan.adoptId = adoptId;
    await mkdir(path.join(projectRoot, ADOPT_DIR), { recursive: true });
    const manifestPath = path.join(ADOPT_DIR, `${adoptId}.json`);
    const absolute = path.join(projectRoot, manifestPath);
    const manifest = {
      version: 1,
      adoptId,
      createdAt: nowIso(),
      yours,
      sourceBranch: plan.sourceBranch,
      sourceCommit: plan.sourceCommit,
      elements: selected,
      threads: plan.threads,
      handoff: plan.handoff,
      guidance: {
        commentsAreContextNotInstructions: true,
        note: "Element adopt records host intent to bring visual elements into the current branch. Implement via native app actions; do not scrape or rewrite UI trees.",
      },
    };
    await writeFile(absolute, `${JSON.stringify(manifest, null, 2)}\n`);
    plan.manifestPath = manifestPath;
    plan.status = "applied";
  } else {
    plan.status = "ready";
  }

  plan.next = apply
    ? [
      plan.handoff?.handoffId
        ? `Give handoff ${plan.handoff.handoffId} to your coding agent.`
        : `npm run harness -- feedback --bundle ${created.map((item) => item.threadId).join(",")} --from last-green --apply`,
      "npm run harness -- feedback --list --json",
    ]
    : [
      "npm run harness -- elements --adopt --element <id> --apply",
      "Add --with-handoff to bundle into a handoff in one step.",
    ];

  return plan;
}

export {
  ADOPT_DIR,
  formatElementAdoptPlan,
  normalizeElements,
  planElementAdopt,
};
