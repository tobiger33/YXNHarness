import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const AGENT_DIR = path.join("artifacts", "agent");
const PROPOSALS_DIR = path.join(AGENT_DIR, "proposals");

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function relativePosix(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function nowIso() {
  return new Date().toISOString();
}

function isSafeRelativePath(rel) {
  if (typeof rel !== "string" || !rel.trim()) return false;
  const normalized = rel.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) return false;
  return true;
}

function unifiedDiff(filePath, before, after) {
  const beforeLines = String(before).split("\n");
  const afterLines = String(after).split("\n");
  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
  // Simple full-file hunk — honest and reviewable for small visual edits.
  lines.push(`@@ -1,${beforeLines.length} +1,${afterLines.length} @@`);
  for (const line of beforeLines) lines.push(`-${line}`);
  for (const line of afterLines) lines.push(`+${line}`);
  return `${lines.join("\n")}\n`;
}

async function proposalPaths(root, proposalId) {
  const dir = path.join(root, PROPOSALS_DIR, proposalId);
  return {
    dir,
    meta: path.join(dir, "proposal.json"),
  };
}

async function writeProposal(root, {
  sessionId = null,
  turnId = null,
  summary,
  files,
  adapterId = "workspace-edit",
} = {}) {
  if (!Array.isArray(files) || !files.length) {
    return { status: "blocked", ok: false, blockedReasons: ["Proposal requires at least one file change."] };
  }
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) {
      return { status: "blocked", ok: false, blockedReasons: [`Unsafe proposal path: ${file.path}`] };
    }
    if (typeof file.before !== "string" || typeof file.after !== "string") {
      return { status: "blocked", ok: false, blockedReasons: [`Proposal file ${file.path} needs before/after text.`] };
    }
  }

  const proposalId = `prop-${randomUUID()}`;
  const paths = await proposalPaths(root, proposalId);
  await mkdir(paths.dir, { recursive: true });
  const createdAt = nowIso();
  const entries = files.map((file) => ({
    path: file.path.replace(/\\/g, "/"),
    before: file.before,
    after: file.after,
    diff: file.diff || unifiedDiff(file.path.replace(/\\/g, "/"), file.before, file.after),
    byteDelta: Buffer.byteLength(file.after) - Buffer.byteLength(file.before),
  }));
  const proposal = {
    version: 1,
    proposalId,
    status: "pending",
    adapterId,
    sessionId,
    turnId,
    summary: String(summary || "Proposed file change").slice(0, 500),
    createdAt,
    updatedAt: createdAt,
    files: entries.map(({ path: filePath, diff, byteDelta }) => ({ path: filePath, diff, byteDelta })),
    // Keep full before/after only on disk for accept; list endpoint omits bodies.
    _bodies: entries.map(({ path: filePath, before, after }) => ({ path: filePath, before, after })),
  };
  await writeFile(paths.meta, `${JSON.stringify(proposal, null, 2)}\n`);
  for (const entry of entries) {
    await writeFile(path.join(paths.dir, `${entry.path.replace(/\//g, "__")}.diff`), entry.diff);
  }
  return {
    status: "proposed",
    ok: true,
    proposal: publicProposal(proposal),
    proposalPath: relativePosix(root, paths.meta),
  };
}

function publicProposal(proposal) {
  if (!proposal) return null;
  const { _bodies, ...rest } = proposal;
  return rest;
}

async function readProposal(root, proposalId) {
  if (!/^prop-[A-Za-z0-9-]{8,80}$/.test(String(proposalId || ""))) {
    const error = new Error("Invalid proposal id.");
    error.statusCode = 400;
    throw error;
  }
  const paths = await proposalPaths(root, proposalId);
  if (!(await pathExists(paths.meta))) {
    const error = new Error("Proposal not found.");
    error.statusCode = 404;
    throw error;
  }
  return JSON.parse(await readFile(paths.meta, "utf8"));
}

async function listProposals(root, { status = null } = {}) {
  const base = path.join(root, PROPOSALS_DIR);
  if (!(await pathExists(base))) return { version: 1, proposals: [] };
  const entries = await readdir(base, { withFileTypes: true });
  const proposals = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const proposal = publicProposal(JSON.parse(await readFile(path.join(base, entry.name, "proposal.json"), "utf8")));
      if (status && proposal.status !== status) continue;
      proposals.push(proposal);
    } catch {
      // skip damaged
    }
  }
  proposals.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return { version: 1, proposals };
}

async function acceptProposal(root, proposalId, {
  force = false,
  appendActivity = null,
} = {}) {
  const proposal = await readProposal(root, proposalId);
  if (proposal.status === "accepted") {
    return { status: "accepted", ok: true, proposal: publicProposal(proposal), noop: true };
  }
  if (proposal.status !== "pending" && !force) {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: [`Proposal is ${proposal.status}; only pending proposals can be accepted.`],
      proposal: publicProposal(proposal),
    };
  }
  const bodies = proposal._bodies || [];
  if (!bodies.length) {
    return { status: "blocked", ok: false, blockedReasons: ["Proposal has no file bodies to apply."] };
  }

  const writes = [];
  for (const file of bodies) {
    if (!isSafeRelativePath(file.path)) {
      return { status: "blocked", ok: false, blockedReasons: [`Unsafe path in proposal: ${file.path}`] };
    }
    const absolute = path.join(root, file.path);
    const rootResolved = path.resolve(root);
    if (!path.resolve(absolute).startsWith(`${rootResolved}${path.sep}`)) {
      return { status: "blocked", ok: false, blockedReasons: [`Path escapes project root: ${file.path}`] };
    }
    let current = "";
    if (await pathExists(absolute)) {
      current = await readFile(absolute, "utf8");
    }
    if (current !== file.before && !force) {
      return {
        status: "blocked",
        ok: false,
        blockedReasons: [
          `File changed since proposal was created: ${file.path}. Re-run the turn or pass force after host consent.`,
        ],
        proposal: publicProposal(proposal),
      };
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.after);
    writes.push(file.path);
  }

  proposal.status = "accepted";
  proposal.updatedAt = nowIso();
  proposal.acceptedAt = proposal.updatedAt;
  proposal.writes = writes;
  const paths = await proposalPaths(root, proposalId);
  await writeFile(paths.meta, `${JSON.stringify(proposal, null, 2)}\n`);

  if (typeof appendActivity === "function") {
    await appendActivity({
      type: "applied-file-change",
      summary: `Accepted proposal ${proposalId}: ${writes.join(", ")}`,
      detail: { proposalId, writes },
      sessionId: proposal.sessionId,
      turnId: proposal.turnId,
    });
  }

  return {
    status: "accepted",
    ok: true,
    proposal: publicProposal(proposal),
    writes,
    explanation: "Host accepted the proposal. Files were written; merge/push remain host-controlled.",
  };
}

async function rejectProposal(root, proposalId, {
  reason = null,
  appendActivity = null,
} = {}) {
  const proposal = await readProposal(root, proposalId);
  if (proposal.status === "rejected") {
    return { status: "rejected", ok: true, proposal: publicProposal(proposal), noop: true };
  }
  if (proposal.status === "accepted") {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: ["Accepted proposals cannot be rejected. Revert with git if needed."],
      proposal: publicProposal(proposal),
    };
  }
  proposal.status = "rejected";
  proposal.updatedAt = nowIso();
  proposal.rejectedAt = proposal.updatedAt;
  proposal.rejectReason = reason != null ? String(reason).slice(0, 500) : null;
  const paths = await proposalPaths(root, proposalId);
  await writeFile(paths.meta, `${JSON.stringify(proposal, null, 2)}\n`);
  if (typeof appendActivity === "function") {
    await appendActivity({
      type: "rejected-file-change",
      summary: `Rejected proposal ${proposalId}`,
      detail: { proposalId, reason: proposal.rejectReason },
      sessionId: proposal.sessionId,
      turnId: proposal.turnId,
    });
  }
  return { status: "rejected", ok: true, proposal: publicProposal(proposal) };
}

export {
  PROPOSALS_DIR,
  acceptProposal,
  listProposals,
  publicProposal,
  readProposal,
  rejectProposal,
  unifiedDiff,
  writeProposal,
};
