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

function longestCommonSubsequence(a, b) {
  const rows = a.length;
  const cols = b.length;
  const dp = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let i = 1; i <= rows; i += 1) {
    for (let j = 1; j <= cols; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const ops = [];
  let i = rows;
  let j = cols;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "equal", line: a[i - 1] });
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "add", line: b[j - 1] });
      j -= 1;
    } else {
      ops.push({ type: "del", line: a[i - 1] });
      i -= 1;
    }
  }
  ops.reverse();
  return ops;
}

function unifiedDiff(filePath, before, after, { context = 3 } = {}) {
  const beforeLines = String(before).split("\n");
  const afterLines = String(after).split("\n");
  // Drop a single trailing empty split so small CSS files stay tidy.
  if (beforeLines.length && beforeLines.at(-1) === "") beforeLines.pop();
  if (afterLines.length && afterLines.at(-1) === "") afterLines.pop();
  const ops = longestCommonSubsequence(beforeLines, afterLines);
  const lines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];

  // Build change blocks with surrounding context — classic coding-agent look.
  const marked = ops.map((op) => ({ ...op, keep: op.type !== "equal" }));
  for (let index = 0; index < marked.length; index += 1) {
    if (marked[index].type !== "equal") continue;
    const nearby = marked.slice(Math.max(0, index - context), index + context + 1)
      .some((entry) => entry.type !== "equal");
    if (nearby) marked[index].keep = true;
  }

  let oldLine = 1;
  let newLine = 1;
  let hunk = null;
  const flush = () => {
    if (!hunk) return;
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    lines.push(...hunk.body);
    hunk = null;
  };

  for (const entry of marked) {
    if (!entry.keep) {
      flush();
      if (entry.type === "equal") {
        oldLine += 1;
        newLine += 1;
      }
      continue;
    }
    if (!hunk) {
      hunk = {
        oldStart: entry.type === "add" ? oldLine : oldLine,
        newStart: entry.type === "del" ? newLine : newLine,
        oldCount: 0,
        newCount: 0,
        body: [],
      };
    }
    if (entry.type === "equal") {
      hunk.body.push(` ${entry.line}`);
      hunk.oldCount += 1;
      hunk.newCount += 1;
      oldLine += 1;
      newLine += 1;
    } else if (entry.type === "del") {
      hunk.body.push(`-${entry.line}`);
      hunk.oldCount += 1;
      oldLine += 1;
    } else {
      hunk.body.push(`+${entry.line}`);
      hunk.newCount += 1;
      newLine += 1;
    }
  }
  flush();
  if (lines.length === 2) {
    lines.push("@@ -0,0 +0,0 @@");
  }
  return `${lines.join("\n")}\n`;
}

function countDiffStats(diffText) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diffText || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
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
  const entries = files.map((file) => {
    const rel = file.path.replace(/\\/g, "/");
    const diff = file.diff || unifiedDiff(rel, file.before, file.after);
    const stats = countDiffStats(diff);
    return {
      path: rel,
      before: file.before,
      after: file.after,
      diff,
      additions: stats.additions,
      deletions: stats.deletions,
      byteDelta: Buffer.byteLength(file.after) - Buffer.byteLength(file.before),
    };
  });
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
    files: entries.map(({ path: filePath, diff, byteDelta, additions, deletions }) => ({
      path: filePath,
      diff,
      byteDelta,
      additions,
      deletions,
    })),
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

function publicProposal(proposal, { includeBodies = false } = {}) {
  if (!proposal) return null;
  const { _bodies, ...rest } = proposal;
  if (!includeBodies) return rest;
  return {
    ...rest,
    files: (proposal.files || []).map((file) => {
      const body = (_bodies || []).find((entry) => entry.path === file.path);
      return {
        ...file,
        before: body?.before ?? null,
        after: body?.after ?? null,
      };
    }),
  };
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
  countDiffStats,
  listProposals,
  publicProposal,
  readProposal,
  rejectProposal,
  unifiedDiff,
  writeProposal,
};
