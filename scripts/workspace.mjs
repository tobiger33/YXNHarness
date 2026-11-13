import { spawnSync } from "node:child_process";
import path from "node:path";

function runGit(root, args, { allowFailure = true } = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (result.error) {
    if (allowFailure) return null;
    throw new Error(`git ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) return null;
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function isSafeBranchName(name) {
  if (!name || typeof name !== "string") return false;
  if (name.length > 200) return false;
  if (name === "-" || name.startsWith("-")) return false;
  if (name.includes("..") || name.includes("\\") || name.includes("//")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".lock")) return false;
  // Local branch names only — no remote-ish paths like origin/foo via this API.
  if (name.includes(":")) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name);
}

/** Compact git stamp for runs / handoffs (stable shape). */
function collectGit(root) {
  const gitRoot = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) return null;
  const status = runGit(root, ["status", "--porcelain=v1"]);
  return {
    branch: runGit(root, ["branch", "--show-current"]),
    commit: runGit(root, ["rev-parse", "HEAD"]),
    dirty: status === null ? null : status.length > 0,
  };
}

function listLocalBranches(root) {
  const raw = runGit(root, [
    "for-each-ref",
    "--format=%(refname:short)\t%(objectname)\t%(objectname:short)\t%(upstream:short)\t%(HEAD)",
    "refs/heads",
  ]);
  if (raw === null) return [];
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [name, commit, shortCommit, upstream, headMark] = line.split("\t");
    return {
      name: name || null,
      commit: commit || null,
      shortCommit: shortCommit || null,
      upstream: upstream || null,
      current: headMark === "*",
    };
  });
}

/**
 * Read-only workspace snapshot for the cockpit.
 * No checkout / create / push — inventory only.
 */
function collectWorkspace(root) {
  const projectRoot = path.resolve(root);
  const gitRoot = runGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot) {
    return {
      version: 1,
      available: false,
      root: projectRoot,
      gitRoot: null,
      branch: null,
      commit: null,
      shortCommit: null,
      detached: null,
      dirty: null,
      changedFiles: null,
      upstream: null,
      ahead: null,
      behind: null,
      branches: [],
      readOnly: true,
      note: "Not a Git repository. Branches stay the code source of truth once Git is present.",
    };
  }

  const branch = runGit(projectRoot, ["branch", "--show-current"]);
  const commit = runGit(projectRoot, ["rev-parse", "HEAD"]);
  const shortCommit = runGit(projectRoot, ["rev-parse", "--short", "HEAD"]);
  const status = runGit(projectRoot, ["status", "--porcelain=v1"]);
  const upstream = runGit(projectRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  let ahead = null;
  let behind = null;
  if (upstream) {
    const counts = runGit(projectRoot, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
    if (counts) {
      const [left, right] = counts.split(/\s+/).map((value) => Number(value));
      if (Number.isFinite(left) && Number.isFinite(right)) {
        ahead = left;
        behind = right;
      }
    }
  }

  const branches = listLocalBranches(projectRoot);
  const changedFiles = status === null ? null : status.split("\n").filter(Boolean).length;

  return {
    version: 1,
    available: true,
    root: projectRoot,
    gitRoot,
    branch: branch || null,
    commit: commit || null,
    shortCommit: shortCommit || null,
    detached: branch ? false : Boolean(commit),
    dirty: status === null ? null : status.length > 0,
    changedFiles,
    upstream: upstream || null,
    ahead,
    behind,
    branches,
    readOnly: true,
    note: "Local branch inventory. Switch with: harness workspace --checkout <branch> --dry-run| --apply. Create/push stay out of scope.",
  };
}

function resolveLocalBranch(root, branchName) {
  if (!isSafeBranchName(branchName)) return null;
  const branches = listLocalBranches(root);
  return branches.find((entry) => entry.name === branchName) || null;
}

/**
 * Host-controlled local branch switch. Preview by default; --apply performs git switch.
 * Never creates branches, never fetches/pushes, never touches remotes.
 */
function planWorkspaceCheckout(root, { branch, apply = false, force = false } = {}) {
  const projectRoot = path.resolve(root);
  const before = collectWorkspace(projectRoot);
  const targetName = typeof branch === "string" ? branch.trim() : "";

  const base = {
    version: 1,
    action: "checkout",
    apply: Boolean(apply),
    force: Boolean(force),
    root: projectRoot,
    from: before.available
      ? {
          branch: before.branch,
          commit: before.commit,
          shortCommit: before.shortCommit,
          dirty: before.dirty,
          changedFiles: before.changedFiles,
        }
      : null,
    to: null,
    blockedReasons: [],
  };

  if (!before.available) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: ["Not a Git repository."],
      workspace: before,
    };
  }

  if (!targetName) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: ["--checkout requires a local branch name."],
      workspace: before,
    };
  }

  if (!isSafeBranchName(targetName)) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: [`Invalid branch name "${targetName}".`],
      workspace: before,
    };
  }

  const target = resolveLocalBranch(projectRoot, targetName);
  if (!target) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: [
        `Local branch "${targetName}" not found. Create it outside the harness (or fetch) before switching.`,
      ],
      workspace: before,
      availableBranches: before.branches.map((entry) => entry.name),
    };
  }

  base.to = {
    branch: target.name,
    commit: target.commit,
    shortCommit: target.shortCommit,
  };

  if (before.branch === target.name) {
    return {
      ...base,
      status: "noop",
      explanation: `Already on ${target.name}.`,
      workspace: before,
    };
  }

  if (before.dirty && !force) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: [
        `Working tree is dirty (${before.changedFiles} changed files). Commit/stash first, or pass --force after host consent.`,
      ],
      workspace: before,
    };
  }

  if (!apply) {
    return {
      ...base,
      status: "ready",
      explanation: force && before.dirty
        ? `Ready to switch ${before.branch || "(detached)"} → ${target.name} with --force (dirty tree).`
        : `Ready to switch ${before.branch || "(detached)"} → ${target.name}.`,
      workspace: before,
    };
  }

  try {
    runGit(projectRoot, ["switch", "--", target.name], { allowFailure: false });
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: [error.message],
      workspace: collectWorkspace(projectRoot),
    };
  }

  const after = collectWorkspace(projectRoot);
  return {
    ...base,
    status: "applied",
    explanation: `Switched to ${after.branch || target.name} @ ${after.shortCommit || after.commit}.`,
    workspace: after,
  };
}

function formatCheckoutPlan(plan) {
  const lines = [
    `Checkout: ${plan.status}`,
    `From: ${plan.from?.branch || "(none)"} @ ${plan.from?.shortCommit || plan.from?.commit || "—"}`,
    `To: ${plan.to?.branch || "(none)"} @ ${plan.to?.shortCommit || plan.to?.commit || "—"}`,
  ];
  if (plan.from?.dirty) {
    lines.push(`Dirty: yes (${plan.from.changedFiles} files)${plan.force ? " · force requested" : ""}`);
  }
  if (plan.explanation) lines.push(plan.explanation);
  for (const reason of plan.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  if (plan.status === "ready") {
    lines.push("Apply with: npm run harness -- workspace --checkout <branch> --apply");
  }
  if (plan.workspace?.available && plan.status === "applied") {
    lines.push(formatWorkspace(plan.workspace));
  }
  return lines.join("\n");
}

function formatWorkspace(workspace) {
  if (!workspace?.available) {
    return [
      "Workspace: Git not detected",
      workspace?.note || "Initialize a repository before treating branches as workspaces.",
    ].join("\n");
  }

  const lines = [
    `Workspace: ${workspace.branch || "(detached)"} @ ${workspace.shortCommit || workspace.commit || "—"}`,
    `Dirty: ${workspace.dirty ? `yes (${workspace.changedFiles} files)` : workspace.dirty === false ? "clean" : "unknown"}`,
  ];
  if (workspace.upstream) {
    lines.push(`Upstream: ${workspace.upstream}` +
      (workspace.ahead != null ? ` · ahead ${workspace.ahead} · behind ${workspace.behind}` : ""));
  } else {
    lines.push("Upstream: none");
  }
  lines.push(`Local branches (${workspace.branches.length}):`);
  for (const entry of workspace.branches.slice(0, 20)) {
    const mark = entry.current ? "*" : " ";
    const up = entry.upstream ? ` → ${entry.upstream}` : "";
    lines.push(`  ${mark} ${entry.name} ${entry.shortCommit || ""}${up}`.trimEnd());
  }
  if (workspace.branches.length > 20) {
    lines.push(`  … ${workspace.branches.length - 20} more`);
  }
  lines.push(workspace.note);
  return lines.join("\n");
}

export {
  collectGit,
  collectWorkspace,
  formatCheckoutPlan,
  formatWorkspace,
  isSafeBranchName,
  listLocalBranches,
  planWorkspaceCheckout,
  resolveLocalBranch,
  runGit,
};
