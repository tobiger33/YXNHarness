import { spawnSync } from "node:child_process";
import path from "node:path";

function runGit(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
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
    note: "Local branch inventory only. Checkout / create stay host-controlled and are not exposed here yet.",
  };
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
  formatWorkspace,
  listLocalBranches,
  runGit,
};
