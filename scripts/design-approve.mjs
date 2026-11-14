import { loadHostConfig } from "./host-config.mjs";
import {
  acceptMergeProposal,
  mergeApproverPolicy,
  writeMergeProposal,
} from "./merge-proposals.mjs";
import { planWorkspaceAdopt } from "./workspace.mjs";
import { withYxnSummaryAttribution, YXN_SUMMARY_FOOTER } from "./workspace-commit.mjs";

const DEFAULT_NOTE = "Design approved";

/**
 * Host/leader design approval: propose a merge with a YXN-attributed summary,
 * then Accept as host (Design passt = host sees and Accepts). Never pushes itself.
 */
async function planDesignApprove(root, {
  theirs,
  apply = false,
  force = false,
  note = null,
  role = "host",
} = {}) {
  const host = await loadHostConfig(root);
  const policy = mergeApproverPolicy(host.config);
  const comment = withYxnSummaryAttribution(
    typeof note === "string" && note.trim() ? note.trim() : DEFAULT_NOTE,
  );
  const normalizedRole = role === "leader" ? "leader" : "host";

  const plan = {
    version: 1,
    action: "design-approve",
    mode: apply ? "apply" : "dry-run",
    mergeAuthority: policy.mergeAuthority,
    policy,
    role: normalizedRole,
    note: comment,
    attribution: YXN_SUMMARY_FOOTER,
    adopt: null,
    mergeProposal: null,
    next: [],
    warnings: [],
    blockedReasons: [],
    status: "ready",
    ok: true,
    explanation: null,
  };

  if (!theirs || typeof theirs !== "string" || !theirs.trim()) {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push("A review branch is required (ref / theirs).");
    plan.explanation = "Select a branch to approve.";
    return plan;
  }

  if (!apply) {
    const adopt = planWorkspaceAdopt(root, {
      theirs: theirs.trim(),
      apply: false,
      force,
      comment,
      paths: null,
      hunks: null,
    });
    plan.adopt = adopt;
    plan.status = adopt.status;
    plan.ok = adopt.status === "ready" || adopt.status === "noop";
    plan.blockedReasons = [...(adopt.blockedReasons || [])];
    plan.workspace = adopt.workspace;
    if (adopt.status === "blocked") {
      plan.explanation = adopt.explanation || "Design approve blocked — see adopt reasons.";
      return plan;
    }
    if (adopt.status === "noop") {
      plan.explanation = adopt.explanation || "Already on that branch — nothing to approve.";
      plan.next = ["Pick a different review branch in Changes."];
      return plan;
    }
    plan.explanation = `Preview: host/leader would Accept merge of ${adopt.theirs?.branch || theirs} with a YXN-authored summary. No merge yet.`;
    plan.next = [
      "Re-run with apply:true / --apply after host or leader review",
      `npm run harness -- workspace --approve ${theirs.trim()} --apply`,
    ];
    plan.warnings.push(
      "Merge runs only after host or configured leader Accept.",
      "Share invites never grant merge rights.",
      "Preview only — working tree unchanged until apply.",
    );
    return plan;
  }

  const proposed = await writeMergeProposal(root, {
    theirs: theirs.trim(),
    summary: comment,
    createdBy: "design-approve",
    apply: true,
  });
  plan.mergeProposal = proposed.proposal || null;
  if (proposed.status === "blocked" || proposed.status === "noop") {
    plan.status = proposed.status;
    plan.ok = proposed.ok;
    plan.blockedReasons = [...(proposed.blockedReasons || [])];
    plan.explanation = proposed.explanation;
    plan.adopt = proposed.adopt || null;
    return plan;
  }

  const accepted = await acceptMergeProposal(root, proposed.proposal.proposalId, {
    role: normalizedRole,
    force,
    apply: true,
  });
  plan.adopt = accepted.adopt || null;
  plan.mergeProposal = accepted.proposal || proposed.proposal;
  plan.status = accepted.status === "accepted" ? "applied" : accepted.status;
  plan.ok = accepted.ok;
  plan.blockedReasons = [...(accepted.blockedReasons || [])];
  plan.workspace = accepted.adopt?.workspace || null;

  if (!accepted.ok) {
    plan.explanation = accepted.explanation || "Design approve Accept failed.";
    return plan;
  }

  plan.explanation = `Design approved by ${normalizedRole}: merged ${proposed.proposal.theirs}. Summary written by YXN. Push when ready so others can fetch.`;
  plan.next = [
    "Push when ready: npm run harness -- workspace --push --apply",
    "Or POST /api/v1/workspace/push with { apply: true }",
    "Collaborators refresh: npm run harness -- workspace --fetch --apply",
  ];
  plan.warnings.push(
    "Merge Accept was host/leader gated. Share invites never grant merge rights.",
    "Push stays a separate host step (--push --apply) for explicit consent.",
  );

  return plan;
}

function formatDesignApprovePlan(plan) {
  const lines = [
    `Design approve: ${plan.status}`,
    `Mode: ${plan.mode}`,
    `Note: ${plan.note}`,
    `Merge authority: ${plan.mergeAuthority}`,
    `Attribution: ${plan.attribution}`,
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
  if (plan.mergeProposal?.proposalId) {
    lines.push(`Merge proposal: ${plan.mergeProposal.proposalId} (${plan.mergeProposal.status})`);
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
