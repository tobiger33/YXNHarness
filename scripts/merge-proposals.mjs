import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadHostConfig } from "./host-config.mjs";
import { planWorkspaceAdopt, runGit } from "./workspace.mjs";
import { withYxnSummaryAttribution, YXN_SUMMARY_FOOTER } from "./workspace-commit.mjs";

const MERGES_DIR = path.join("artifacts", "merges", "proposals");

/** True when every porcelain path is under artifacts/ (harness-managed). */
function isHarnessArtifactsOnlyDirty(root) {
  const status = runGit(root, ["status", "--porcelain=v1"]);
  if (!status) return false;
  const lines = status.split("\n").filter(Boolean);
  if (!lines.length) return false;
  return lines.every((line) => {
    const raw = line.slice(3).trim();
    const filePath = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
    return String(filePath || "").replaceAll("\\", "/").startsWith("artifacts/");
  });
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function relativePosix(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function mergeApproverPolicy(hostConfig) {
  const access = hostConfig?.access || {};
  const leader = access.leader && typeof access.leader === "object"
    ? { label: String(access.leader.label || "").trim() || null }
    : null;
  const hasLeader = Boolean(leader?.label);
  // Host always may accept. Leader may accept only when configured.
  return {
    mergeAuthority: access.mergeAuthority || "host",
    leader,
    canHostAccept: true,
    canLeaderAccept: hasLeader,
    approvers: hasLeader ? ["host", "leader"] : ["host"],
  };
}

function canRoleAcceptMerge(policy, role) {
  if (role === "host") return policy.canHostAccept;
  if (role === "leader") return policy.canLeaderAccept;
  return false;
}

async function proposalPaths(root, proposalId) {
  const dir = path.join(root, MERGES_DIR, proposalId);
  return { dir, meta: path.join(dir, "proposal.json") };
}

async function writeMergeProposal(root, {
  theirs,
  summary,
  note = null,
  createdBy = "yxn",
  apply = true,
} = {}) {
  const host = await loadHostConfig(root);
  const policy = mergeApproverPolicy(host.config);
  const message = withYxnSummaryAttribution(summary || note || "Merge proposed");
  const plan = {
    version: 1,
    action: "merge-propose",
    mode: apply ? "apply" : "dry-run",
    status: "ready",
    ok: true,
    policy,
    attribution: YXN_SUMMARY_FOOTER,
    blockedReasons: [],
    warnings: [
      "Merge does not run until host or configured leader Accepts.",
      "Share links never grant merge rights.",
    ],
    next: [],
    explanation: null,
    proposal: null,
    proposalPath: null,
  };

  if (!theirs || typeof theirs !== "string" || !theirs.trim()) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push("A review branch (theirs) is required.");
    plan.explanation = "Select a branch to propose for merge.";
    return plan;
  }
  if (!message) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push("A merge summary is required.");
    plan.explanation = "Write a short summary for host/leader review.";
    return plan;
  }

  // Dry-run adopt to validate mergeability without writing.
  const preview = planWorkspaceAdopt(root, {
    theirs: theirs.trim(),
    apply: false,
    force: false,
    comment: message,
    paths: null,
    hunks: null,
  });
  if (preview.status === "blocked") {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons = [...(preview.blockedReasons || [])];
    plan.explanation = preview.explanation || "Merge proposal blocked.";
    plan.adopt = preview;
    return plan;
  }
  if (preview.status === "noop") {
    plan.status = "noop";
    plan.ok = true;
    plan.explanation = preview.explanation || "Nothing to merge.";
    plan.adopt = preview;
    return plan;
  }

  const proposalId = `merge-${randomUUID()}`;
  const createdAt = nowIso();
  const proposal = {
    version: 1,
    proposalId,
    status: "pending",
    theirs: theirs.trim(),
    yours: preview.workspace?.branch || null,
    summary: message,
    attribution: YXN_SUMMARY_FOOTER,
    createdBy: String(createdBy || "yxn").slice(0, 80),
    createdAt,
    updatedAt: createdAt,
    acceptedAt: null,
    acceptedBy: null,
    policy: {
      approvers: policy.approvers,
      leaderLabel: policy.leader?.label || null,
    },
  };
  plan.adopt = preview;
  plan.proposal = proposal;

  if (!apply) {
    plan.status = "ready";
    plan.ok = true;
    plan.explanation = `Preview: would propose merge of ${proposal.theirs} for ${policy.approvers.join(" or ")} Accept. Summary written by YXN.`;
    plan.next = [
      "Re-run with apply:true / --apply to queue the merge proposal.",
    ];
    plan.warnings.push("Preview only — no proposal file written yet.");
    return plan;
  }

  const paths = await proposalPaths(root, proposalId);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.meta, `${JSON.stringify(proposal, null, 2)}\n`);

  plan.status = "proposed";
  plan.ok = true;
  plan.proposalPath = relativePosix(root, paths.meta);
  plan.explanation = `Merge proposal ${proposalId} waiting for ${policy.approvers.join(" or ")} Accept.`;
  plan.next = [
    `POST /api/v1/workspace/merge-proposals/${proposalId}/accept { "role": "host" }`,
    ...(policy.canLeaderAccept
      ? [`Or Accept as leader (${policy.leader.label}).`]
      : []),
  ];
  return plan;
}

async function readMergeProposal(root, proposalId) {
  if (!/^merge-[A-Za-z0-9-]{8,80}$/.test(String(proposalId || ""))) {
    const error = new Error("Invalid merge proposal id.");
    error.statusCode = 400;
    throw error;
  }
  const paths = await proposalPaths(root, proposalId);
  if (!(await pathExists(paths.meta))) {
    const error = new Error("Merge proposal not found.");
    error.statusCode = 404;
    throw error;
  }
  return JSON.parse(await readFile(paths.meta, "utf8"));
}

async function listMergeProposals(root, { status = null } = {}) {
  const base = path.join(root, MERGES_DIR);
  if (!(await pathExists(base))) return { version: 1, proposals: [] };
  const entries = await readdir(base, { withFileTypes: true });
  const proposals = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const proposal = JSON.parse(await readFile(path.join(base, entry.name, "proposal.json"), "utf8"));
      if (status && proposal.status !== status) continue;
      proposals.push(proposal);
    } catch {
      // skip damaged
    }
  }
  proposals.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return { version: 1, proposals };
}

async function acceptMergeProposal(root, proposalId, {
  role = "host",
  force = false,
  apply = true,
} = {}) {
  const host = await loadHostConfig(root);
  const policy = mergeApproverPolicy(host.config);
  const normalizedRole = role === "leader" ? "leader" : "host";
  const plan = {
    version: 1,
    action: "merge-accept",
    status: "ready",
    ok: true,
    role: normalizedRole,
    policy,
    blockedReasons: [],
    warnings: [],
    next: [],
    explanation: null,
    proposal: null,
    adopt: null,
  };

  if (!canRoleAcceptMerge(policy, normalizedRole)) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push(
      normalizedRole === "leader"
        ? "No leader configured in harness.host.json access.leader — only the host can Accept merges."
        : "This role cannot Accept merges under current host policy.",
    );
    plan.explanation = "Merge Accept refused by policy.";
    return plan;
  }

  const proposal = await readMergeProposal(root, proposalId);
  plan.proposal = proposal;
  if (proposal.status === "accepted") {
    plan.status = "accepted";
    plan.ok = true;
    plan.explanation = "Merge proposal already accepted.";
    plan.noop = true;
    return plan;
  }
  if (proposal.status === "rejected") {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push("Merge proposal was rejected.");
    return plan;
  }
  if (proposal.status !== "pending") {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push(`Merge proposal is ${proposal.status}.`);
    return plan;
  }

  // Proposal files live under artifacts/; ignore that harness-only dirtiness for Accept.
  const forceAdopt = force || isHarnessArtifactsOnlyDirty(root);

  if (!apply) {
    const preview = planWorkspaceAdopt(root, {
      theirs: proposal.theirs,
      apply: false,
      force: forceAdopt,
      comment: proposal.summary,
      paths: null,
      hunks: null,
    });
    plan.adopt = preview;
    plan.status = preview.status;
    plan.ok = preview.status !== "blocked";
    plan.blockedReasons = [...(preview.blockedReasons || [])];
    plan.explanation = preview.explanation || "Preview merge for host/leader review.";
    return plan;
  }

  const adopt = planWorkspaceAdopt(root, {
    theirs: proposal.theirs,
    apply: true,
    force: forceAdopt,
    comment: proposal.summary,
    paths: null,
    hunks: null,
  });
  plan.adopt = adopt;
  if (adopt.status === "blocked") {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons = [...(adopt.blockedReasons || [])];
    plan.explanation = adopt.explanation || "Merge Accept blocked.";
    return plan;
  }

  proposal.status = "accepted";
  proposal.updatedAt = nowIso();
  proposal.acceptedAt = proposal.updatedAt;
  proposal.acceptedBy = normalizedRole;
  const paths = await proposalPaths(root, proposalId);
  await writeFile(paths.meta, `${JSON.stringify(proposal, null, 2)}\n`);
  plan.proposal = proposal;
  plan.status = "accepted";
  plan.ok = true;
  plan.explanation = adopt.explanation
    || `Merge accepted by ${normalizedRole}: ${proposal.theirs} → ${proposal.yours || "current"}.`;
  plan.next = [
    "Push when ready: npm run harness -- workspace --push --apply",
    "Collaborators: npm run harness -- workspace --fetch --apply",
  ];
  plan.warnings.push("Push stays a separate host step for explicit consent.");
  return plan;
}

async function rejectMergeProposal(root, proposalId, { role = "host", reason = null } = {}) {
  const host = await loadHostConfig(root);
  const policy = mergeApproverPolicy(host.config);
  const normalizedRole = role === "leader" ? "leader" : "host";
  if (!canRoleAcceptMerge(policy, normalizedRole)) {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: ["This role cannot Reject merges under current host policy."],
    };
  }
  const proposal = await readMergeProposal(root, proposalId);
  if (proposal.status === "accepted") {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: ["Accepted merges cannot be rejected. Revert with git if needed."],
      proposal,
    };
  }
  proposal.status = "rejected";
  proposal.updatedAt = nowIso();
  proposal.rejectedAt = proposal.updatedAt;
  proposal.rejectedBy = normalizedRole;
  proposal.rejectReason = reason != null ? String(reason).slice(0, 500) : null;
  const paths = await proposalPaths(root, proposalId);
  await writeFile(paths.meta, `${JSON.stringify(proposal, null, 2)}\n`);
  return { status: "rejected", ok: true, proposal };
}

export {
  MERGES_DIR,
  acceptMergeProposal,
  canRoleAcceptMerge,
  listMergeProposals,
  mergeApproverPolicy,
  readMergeProposal,
  rejectMergeProposal,
  writeMergeProposal,
};
