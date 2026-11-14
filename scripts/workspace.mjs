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
    note: "Local branches: --checkout|--create|--review|--adopt. Push/fetch stay out of scope.",
  };
}

function isSafeRelPath(relPath) {
  if (!relPath || typeof relPath !== "string") return false;
  if (relPath.length > 500) return false;
  if (relPath.startsWith("/") || relPath.includes("\\") || relPath.includes("\0")) return false;
  if (relPath.split("/").some((part) => part === ".." || part === "")) return false;
  return true;
}

function parseNumstat(raw) {
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [added, deleted, ...rest] = line.split("\t");
    const pathName = rest.join("\t");
    // renames: "old => new" in path with curly braces sometimes; keep raw path label
    return {
      path: pathName || null,
      additions: added === "-" ? null : Number(added),
      deletions: deleted === "-" ? null : Number(deleted),
    };
  }).filter((entry) => entry.path);
}

function parseNameStatus(raw) {
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map((line) => {
    const [status, ...parts] = line.split("\t");
    if (status?.startsWith("R") || status?.startsWith("C")) {
      return { status: status[0], path: parts[1] || parts[0] || null, from: parts[0] || null };
    }
    return { status: status || "M", path: parts[0] || null, from: null };
  }).filter((entry) => entry.path);
}

/**
 * GitHub/Cursor-style review: what would change on *your* branch if you adopt *theirs*.
 * Uses three-dot diff (merge-base...theirs), like a PR file list.
 */
function buildWorkspaceReview(root, { theirs, path: filePath = null } = {}) {
  const projectRoot = path.resolve(root);
  const before = collectWorkspace(projectRoot);
  const targetName = typeof theirs === "string" ? theirs.trim() : "";

  const base = {
    version: 1,
    action: "review",
    root: projectRoot,
    yours: before.available
      ? { branch: before.branch, commit: before.commit, shortCommit: before.shortCommit }
      : null,
    theirs: null,
    mergeBase: null,
    files: [],
    summary: { filesChanged: 0, additions: 0, deletions: 0 },
    patch: null,
    blockedReasons: [],
  };

  if (!before.available) {
    return { ...base, status: "blocked", blockedReasons: ["Not a Git repository."] };
  }
  if (!targetName || !isSafeBranchName(targetName)) {
    return { ...base, status: "blocked", blockedReasons: ["--review requires an existing local branch name."] };
  }
  const target = resolveLocalBranch(projectRoot, targetName);
  if (!target) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: [`Local branch "${targetName}" not found.`],
      availableBranches: before.branches.map((entry) => entry.name),
    };
  }
  if (before.branch === target.name) {
    return {
      ...base,
      status: "noop",
      theirs: { branch: target.name, commit: target.commit, shortCommit: target.shortCommit },
      explanation: "Already on that branch — nothing to review.",
    };
  }

  base.theirs = { branch: target.name, commit: target.commit, shortCommit: target.shortCommit };
  const mergeBase = runGit(projectRoot, ["merge-base", "HEAD", target.name]);
  base.mergeBase = mergeBase
    ? { commit: mergeBase, shortCommit: runGit(projectRoot, ["rev-parse", "--short", mergeBase]) }
    : null;

  const range = `HEAD...${target.name}`;
  const nameStatus = parseNameStatus(runGit(projectRoot, ["diff", "--name-status", "-M", range]) || "");
  const numstat = parseNumstat(runGit(projectRoot, ["diff", "--numstat", "-M", range]) || "");
  const byPath = new Map(numstat.map((entry) => [entry.path, entry]));
  const files = nameStatus.map((entry) => {
    const stats = byPath.get(entry.path) || {};
    return {
      path: entry.path,
      status: entry.status,
      from: entry.from,
      additions: Number.isFinite(stats.additions) ? stats.additions : 0,
      deletions: Number.isFinite(stats.deletions) ? stats.deletions : 0,
    };
  });

  base.files = files;
  base.summary = {
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + (file.additions || 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0),
  };

  if (filePath) {
    if (!isSafeRelPath(filePath)) {
      return { ...base, status: "blocked", blockedReasons: [`Invalid path "${filePath}".`] };
    }
    const matched = files.find((file) => file.path === filePath);
    if (!matched) {
      return { ...base, status: "blocked", blockedReasons: [`Path "${filePath}" is not in this review.`] };
    }
    const filePatch = runGit(projectRoot, ["diff", "-M", range, "--", filePath]);
    base.patch = {
      path: filePath,
      status: matched.status,
      text: filePatch || "",
      truncated: false,
    };
    if (base.patch.text.length > 200_000) {
      base.patch.text = `${base.patch.text.slice(0, 200_000)}\n\n… truncated …\n`;
      base.patch.truncated = true;
    }
  }

  return {
    ...base,
    status: "ready",
    explanation: files.length
      ? `Review ${before.branch || "HEAD"} ← ${target.name}: ${files.length} file(s), +${base.summary.additions}/-${base.summary.deletions}.`
      : `${target.name} has no unique changes since the merge-base.`,
  };
}

function formatWorkspaceReview(review) {
  const lines = [
    `Review: ${review.status}`,
    `Yours: ${review.yours?.branch || "—"} @ ${review.yours?.shortCommit || "—"}`,
    `Theirs: ${review.theirs?.branch || "—"} @ ${review.theirs?.shortCommit || "—"}`,
  ];
  if (review.explanation) lines.push(review.explanation);
  for (const reason of review.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  if (review.files?.length) {
    lines.push("Files:");
    for (const file of review.files.slice(0, 40)) {
      lines.push(`  ${file.status} ${file.path} (+${file.additions}/-${file.deletions})`);
    }
    if (review.files.length > 40) lines.push(`  … ${review.files.length - 40} more`);
  }
  if (review.patch?.text) {
    lines.push("", `Patch ${review.patch.path}:`, review.patch.text);
  }
  return lines.join("\n");
}

const ADOPT_COMMENT_MAX = 2000;

/** Optional merge note — host/agent context, never executed as instructions. */
function normalizeAdoptComment(value) {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return null;
  if (trimmed.includes("\0")) {
    const error = new Error("Adopt comment must not contain null bytes.");
    error.code = "INVALID_ADOPT_COMMENT";
    throw error;
  }
  if (trimmed.length > ADOPT_COMMENT_MAX) {
    const error = new Error(`Adopt comment exceeds ${ADOPT_COMMENT_MAX} characters.`);
    error.code = "INVALID_ADOPT_COMMENT";
    throw error;
  }
  return trimmed;
}

function buildAdoptMergeMessage({ yours, theirs, comment = null } = {}) {
  const subject = `Adopt ${theirs} into ${yours}`;
  if (!comment) return subject;
  return `${subject}\n\n${comment}`;
}

/**
 * Adopt *theirs* into the current branch (git merge). Host-controlled; no push.
 * Optional comment is recorded on the merge commit (forces --no-ff when present).
 */
function planWorkspaceAdopt(root, { theirs, apply = false, force = false, comment = null } = {}) {
  const projectRoot = path.resolve(root);
  const before = collectWorkspace(projectRoot);
  const targetName = typeof theirs === "string" ? theirs.trim() : "";
  let adoptComment = null;
  try {
    adoptComment = normalizeAdoptComment(comment);
  } catch (error) {
    return {
      version: 1,
      action: "adopt",
      apply: Boolean(apply),
      force: Boolean(force),
      root: projectRoot,
      yours: before.available
        ? {
            branch: before.branch,
            commit: before.commit,
            shortCommit: before.shortCommit,
            dirty: before.dirty,
            changedFiles: before.changedFiles,
          }
        : null,
      theirs: null,
      review: null,
      comment: null,
      blockedReasons: [error.message],
      status: "blocked",
      workspace: before,
    };
  }

  const base = {
    version: 1,
    action: "adopt",
    apply: Boolean(apply),
    force: Boolean(force),
    root: projectRoot,
    yours: before.available
      ? {
          branch: before.branch,
          commit: before.commit,
          shortCommit: before.shortCommit,
          dirty: before.dirty,
          changedFiles: before.changedFiles,
        }
      : null,
    theirs: null,
    review: null,
    comment: adoptComment,
    blockedReasons: [],
  };

  if (!before.available) {
    return { ...base, status: "blocked", blockedReasons: ["Not a Git repository."], workspace: before };
  }
  if (!before.branch) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: ["Detached HEAD — checkout a branch before adopting."],
      workspace: before,
    };
  }
  if (!targetName || !isSafeBranchName(targetName)) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: ["--adopt requires an existing local branch name."],
      workspace: before,
    };
  }
  const target = resolveLocalBranch(projectRoot, targetName);
  if (!target) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: [`Local branch "${targetName}" not found.`],
      workspace: before,
      availableBranches: before.branches.map((entry) => entry.name),
    };
  }
  if (before.branch === target.name) {
    return {
      ...base,
      status: "noop",
      theirs: { branch: target.name, commit: target.commit, shortCommit: target.shortCommit },
      explanation: "Already on that branch.",
      workspace: before,
    };
  }

  base.theirs = { branch: target.name, commit: target.commit, shortCommit: target.shortCommit };
  const review = buildWorkspaceReview(projectRoot, { theirs: target.name });
  base.review = {
    status: review.status,
    summary: review.summary,
    files: review.files?.slice(0, 50) || [],
  };

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

  const mergeMessage = buildAdoptMergeMessage({
    yours: before.branch,
    theirs: target.name,
    comment: adoptComment,
  });
  base.mergeMessage = mergeMessage;

  if (!apply) {
    return {
      ...base,
      status: "ready",
      explanation: `Ready to merge ${target.name} into ${before.branch}` +
        (review.summary?.filesChanged
          ? ` (${review.summary.filesChanged} files, +${review.summary.additions}/-${review.summary.deletions})`
          : " (no unique file changes — may still fast-forward/record merge)") +
        (adoptComment ? " with a merge note." : "."),
      workspace: before,
    };
  }

  try {
    // A comment must land on a merge commit, so force --no-ff when one is provided.
    const mergeArgs = adoptComment
      ? ["merge", "--no-ff", "-m", mergeMessage, "--", target.name]
      : ["merge", "--no-edit", "--", target.name];
    runGit(projectRoot, mergeArgs, { allowFailure: false });
  } catch (error) {
    // Leave conflict state visible; agent/host must resolve with plain git.
    return {
      ...base,
      status: "blocked",
      blockedReasons: [
        error.message,
        "If this is a merge conflict, resolve it with git, then commit. Harness does not auto-resolve conflicts.",
      ],
      workspace: collectWorkspace(projectRoot),
    };
  }

  const after = collectWorkspace(projectRoot);
  return {
    ...base,
    status: "applied",
    explanation: `Adopted ${target.name} into ${after.branch} @ ${after.shortCommit || after.commit}` +
      (adoptComment ? " (merge note recorded)." : "."),
    workspace: after,
  };
}

function formatAdoptPlan(plan) {
  const lines = [
    `Adopt: ${plan.status}`,
    `Yours: ${plan.yours?.branch || "—"} @ ${plan.yours?.shortCommit || "—"}`,
    `Theirs: ${plan.theirs?.branch || "—"} @ ${plan.theirs?.shortCommit || "—"}`,
  ];
  if (plan.review?.summary) {
    lines.push(
      `Diff: ${plan.review.summary.filesChanged} files · +${plan.review.summary.additions}/-${plan.review.summary.deletions}`,
    );
  }
  if (plan.comment) lines.push(`Note: ${plan.comment}`);
  if (plan.explanation) lines.push(plan.explanation);
  for (const reason of plan.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  if (plan.status === "ready") {
    lines.push("Apply with: npm run harness -- workspace --adopt <branch> --apply [--note \"…\"]");
  }
  if (plan.workspace?.available && plan.status === "applied") {
    lines.push(formatWorkspace(plan.workspace));
  }
  return lines.join("\n");
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

/**
 * Host-controlled local branch create + switch.
 * Starts from HEAD, or from an existing local branch via `from`.
 * Never fetches/pushes or sets upstream.
 */
function planWorkspaceCreate(root, { branch, from = null, apply = false, force = false } = {}) {
  const projectRoot = path.resolve(root);
  const before = collectWorkspace(projectRoot);
  const targetName = typeof branch === "string" ? branch.trim() : "";
  const fromName = typeof from === "string" && from.trim() ? from.trim() : null;

  const base = {
    version: 1,
    action: "create",
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
    startPoint: null,
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
      blockedReasons: ["--create requires a new local branch name."],
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

  if (resolveLocalBranch(projectRoot, targetName)) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: [
        `Local branch "${targetName}" already exists. Use --checkout to switch, or pick another name.`,
      ],
      workspace: before,
      availableBranches: before.branches.map((entry) => entry.name),
    };
  }

  let startPoint = {
    branch: before.branch,
    commit: before.commit,
    shortCommit: before.shortCommit,
    ref: "HEAD",
  };

  if (fromName) {
    if (!isSafeBranchName(fromName)) {
      return {
        ...base,
        status: "blocked",
        blockedReasons: [`Invalid --from branch name "${fromName}".`],
        workspace: before,
      };
    }
    const source = resolveLocalBranch(projectRoot, fromName);
    if (!source) {
      return {
        ...base,
        status: "blocked",
        blockedReasons: [
          `Local start branch "${fromName}" not found. --from only accepts existing local branches.`,
        ],
        workspace: before,
        availableBranches: before.branches.map((entry) => entry.name),
      };
    }
    startPoint = {
      branch: source.name,
      commit: source.commit,
      shortCommit: source.shortCommit,
      ref: source.name,
    };
  }

  if (!startPoint.commit) {
    return {
      ...base,
      status: "blocked",
      blockedReasons: ["Repository has no commit to branch from yet."],
      workspace: before,
    };
  }

  base.startPoint = startPoint;
  base.to = {
    branch: targetName,
    commit: startPoint.commit,
    shortCommit: startPoint.shortCommit,
  };

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
      explanation: `Ready to create ${targetName} from ${startPoint.ref}` +
        (force && before.dirty ? " with --force (dirty tree)" : "") +
        " and switch onto it.",
      workspace: before,
    };
  }

  try {
    if (startPoint.ref === "HEAD") {
      runGit(projectRoot, ["switch", "-c", targetName], { allowFailure: false });
    } else {
      runGit(projectRoot, ["switch", "-c", targetName, "--", startPoint.ref], { allowFailure: false });
    }
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
    explanation: `Created and switched to ${after.branch || targetName} @ ${after.shortCommit || after.commit}.`,
    workspace: after,
  };
}

function formatCreatePlan(plan) {
  const lines = [
    `Create branch: ${plan.status}`,
    `Start: ${plan.startPoint?.ref || "(none)"} @ ${plan.startPoint?.shortCommit || plan.startPoint?.commit || "—"}`,
    `New: ${plan.to?.branch || "(none)"}`,
  ];
  if (plan.from?.dirty) {
    lines.push(`Dirty: yes (${plan.from.changedFiles} files)${plan.force ? " · force requested" : ""}`);
  }
  if (plan.explanation) lines.push(plan.explanation);
  for (const reason of plan.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  if (plan.status === "ready") {
    lines.push("Apply with: npm run harness -- workspace --create <branch> --apply");
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
  buildAdoptMergeMessage,
  buildWorkspaceReview,
  collectGit,
  collectWorkspace,
  formatAdoptPlan,
  formatCheckoutPlan,
  formatCreatePlan,
  formatWorkspace,
  formatWorkspaceReview,
  isSafeBranchName,
  listLocalBranches,
  normalizeAdoptComment,
  planWorkspaceAdopt,
  planWorkspaceCheckout,
  planWorkspaceCreate,
  resolveLocalBranch,
  runGit,
};
