import { loadHostConfig } from "./host-config.mjs";
import { planWorkspaceAdopt } from "./workspace.mjs";

const DEFAULT_NOTE = "Design approved";

/**
 * Host-controlled design approval: whole-branch adopt with a clear note,
 * then explicit next steps (push + collaborator fetch). Never pushes itself.
 */
async function planDesignApprove(root, {
  theirs,
  apply = false,
  force = false,
  note = null,
} = {}) {
  const host = await loadHostConfig(root);
  const mergeAuthority = host.config?.access?.mergeAuthority || "host";
  const comment = typeof note === "string" && note.trim()
    ? note.trim()
    : DEFAULT_NOTE;

  const plan = {
    version: 1,
    action: "design-approve",
    mode: apply ? "apply" : "dry-run",
    mergeAuthority,
    note: comment,
    adopt: null,
    next: [],
    warnings: [],
    blockedReasons: [],
    status: "ready",
    ok: true,
    explanation: null,
  };

  if (mergeAuthority !== "host") {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push(
      `mergeAuthority is "${mergeAuthority}". Design approve only runs when the host holds merge authority.`,
    );
    plan.explanation = "Design approve refused by host policy.";
    return plan;
  }

  if (!theirs || typeof theirs !== "string" || !theirs.trim()) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push("A review branch is required (ref / theirs).");
    plan.explanation = "Select a branch to approve.";
    return plan;
  }

  const adopt = planWorkspaceAdopt(root, {
    theirs: theirs.trim(),
    apply,
    force,
    comment,
    paths: null,
    hunks: null,
  });
  plan.adopt = adopt;
  plan.status = adopt.status;
  plan.ok = adopt.status === "ready" || adopt.status === "applied" || adopt.status === "noop";
  plan.blockedReasons = [...(adopt.blockedReasons || [])];
  plan.workspace = adopt.workspace;

  if (adopt.status === "blocked") {
    plan.explanation = adopt.explanation || "Design approve blocked — see adopt reasons.";
    return plan;
  }

  if (adopt.status === "noop") {
    plan.explanation = adopt.explanation || "Already on that branch — nothing to approve.";
    plan.next = [
      "Pick a different review branch in Changes.",
    ];
    return plan;
  }

  plan.explanation = apply
    ? `Design approved: merged ${adopt.theirs?.branch || theirs} into ${adopt.workspace?.branch || "current branch"}. Push when ready so others can fetch.`
    : `Preview: would merge ${adopt.theirs?.branch || theirs} into your branch with note "${comment}". No push.`;

  plan.next = apply
    ? [
        "Push your branch with plain git (harness does not push): git push",
        "Tell collaborators to refresh: npm run harness -- workspace --fetch --apply",
        "Or POST /api/v1/workspace/fetch with { apply: true } from the cockpit",
      ]
    : [
        "Re-run with apply:true / --apply after host review",
        `npm run harness -- workspace --approve ${theirs.trim()} --apply`,
      ];

  plan.warnings.push(
    "Merge authority stays with the host. Share invites never grant merge rights.",
  );
  if (!apply) {
    plan.warnings.push("Preview only — working tree unchanged until apply.");
  } else {
    plan.warnings.push("Push is still a separate host step for efficiency and explicit consent.");
  }

  return plan;
}

function formatDesignApprovePlan(plan) {
  const lines = [
    `Design approve: ${plan.status}`,
    `Mode: ${plan.mode}`,
    `Note: ${plan.note}`,
    `Merge authority: ${plan.mergeAuthority}`,
  ];
  if (plan.adopt) {
    lines.push(
      `Adopt: ${plan.adopt.status} · ${plan.adopt.yours?.branch || "—"} ← ${plan.adopt.theirs?.branch || "—"}`,
    );
    if (plan.adopt.review?.summary) {
      const summary = plan.adopt.review.summary;
      lines.push(
        `Diff: ${summary.filesChanged} files · +${summary.additions}/-${summary.deletions}`,
      );
    }
  }
  if (plan.explanation) lines.push(plan.explanation);
  for (const reason of plan.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  for (const warning of plan.warnings || []) lines.push(`Note: ${warning}`);
  for (const step of plan.next || []) lines.push(`Next: ${step}`);
  return lines.join("\n");
}

export {
  DEFAULT_NOTE,
  formatDesignApprovePlan,
  planDesignApprove,
};
