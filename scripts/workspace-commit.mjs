import { loadHostConfig } from "./host-config.mjs";
import { collectWorkspace, runGit } from "./workspace.mjs";

const YXN_SUMMARY_FOOTER = "Summary written by YXN.";

function withYxnSummaryAttribution(message) {
  const body = String(message || "").trim();
  if (!body) return null;
  if (body.includes(YXN_SUMMARY_FOOTER)) return body;
  return `${body}\n\n${YXN_SUMMARY_FOOTER}`;
}

/**
 * Host-controlled commit of the current dirty worktree / index.
 * Summary is always attributed to YXN in the commit message trailer.
 */
async function planWorkspaceCommit(root, {
  message = null,
  paths = null,
  apply = false,
  allowEmpty = false,
} = {}) {
  const host = await loadHostConfig(root);
  const workspace = collectWorkspace(root);
  const finalMessage = withYxnSummaryAttribution(message);
  const plan = {
    version: 1,
    action: "commit",
    mode: apply ? "apply" : "dry-run",
    status: "ready",
    ok: true,
    message: finalMessage,
    attribution: YXN_SUMMARY_FOOTER,
    paths: Array.isArray(paths) ? paths.filter(Boolean) : null,
    workspace: {
      available: workspace.available,
      branch: workspace.branch,
      commit: workspace.commit,
      shortCommit: workspace.shortCommit,
      dirty: workspace.dirty,
    },
    writes: [],
    blockedReasons: [],
    warnings: [
      "Commit messages drafted in the harness include a YXN attribution trailer.",
      "Merge authority stays with the host (or configured leader).",
    ],
    next: [],
    explanation: null,
  };

  if (!workspace.available) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push("Not a Git workspace.");
    plan.explanation = "Open a Git project to commit.";
    return plan;
  }
  if (workspace.detached) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push("Detached HEAD — checkout a branch before committing.");
    plan.explanation = "Commit refused on detached HEAD.";
    return plan;
  }
  if (!finalMessage) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push("A commit summary is required.");
    plan.explanation = "Write a short summary for this commit.";
    return plan;
  }
  if (!workspace.dirty && !allowEmpty) {
    plan.status = "noop";
    plan.ok = true;
    plan.explanation = "Working tree is clean — nothing to commit.";
    return plan;
  }

  plan.explanation = apply
    ? `Committing on ${workspace.branch} with a YXN-authored summary.`
    : `Preview: commit on ${workspace.branch} with YXN summary attribution. Working tree unchanged until apply.`;
  plan.next = apply
    ? ["Push when ready: POST /api/v1/workspace/push { apply: true }"]
    : ["Re-run with apply:true after reviewing the summary."];

  if (!apply) return plan;

  try {
    if (plan.paths?.length) {
      for (const filePath of plan.paths) {
        runGit(root, ["add", "--", filePath], { allowFailure: false, timeoutMs: 30000 });
      }
    } else {
      runGit(root, ["add", "-A"], { allowFailure: false, timeoutMs: 30000 });
    }
    const staged = runGit(root, ["diff", "--cached", "--name-only"], { timeoutMs: 30000 }) || "";
    if (!staged.trim() && !allowEmpty) {
      plan.status = "noop";
      plan.explanation = "Nothing staged after add — nothing to commit.";
      return plan;
    }
    runGit(root, ["commit", "-m", finalMessage], { allowFailure: false, timeoutMs: 30000 });
    const after = collectWorkspace(root);
    plan.status = "applied";
    plan.ok = true;
    plan.writes = ["git-commit"];
    plan.workspace = {
      available: after.available,
      branch: after.branch,
      commit: after.commit,
      shortCommit: after.shortCommit,
      dirty: after.dirty,
    };
    plan.explanation = `Committed on ${after.branch} (${after.shortCommit}). Summary written by YXN.`;
    plan.next = [
      "Push when ready: npm run harness -- workspace --push --apply",
      "Or propose a merge for host/leader Accept.",
    ];
  } catch (error) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push(error.message || "git commit failed");
    plan.explanation = "Commit failed — resolve with git, then retry.";
  }

  return plan;
}

function formatCommitPlan(plan) {
  const lines = [
    `Commit: ${plan.status}`,
    `Mode: ${plan.mode}`,
    `Attribution: ${plan.attribution}`,
  ];
  if (plan.message) lines.push(`Message:\n${plan.message}`);
  if (plan.explanation) lines.push(plan.explanation);
  for (const reason of plan.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  return lines.join("\n");
}

export {
  YXN_SUMMARY_FOOTER,
  formatCommitPlan,
  planWorkspaceCommit,
  withYxnSummaryAttribution,
};
