import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadHostConfig } from "./host-config.mjs";
import { collectGit, collectWorkspace } from "./workspace.mjs";

const SHARES_DIR = path.join("artifacts", "shares");

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function relativePosix(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function buildShareId(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `share-${stamp}`;
}

function buildShareManifest({
  shareId,
  host,
  git,
  workspace,
  note,
  createdAt,
}) {
  const access = host?.config?.access || {
    visibility: "private",
    shareLinkGrant: "view",
    mergeAuthority: "host",
  };
  const grant = access.shareLinkGrant === "comment" ? "comment" : "view";
  return {
    version: 1,
    shareId,
    createdAt,
    note: note || null,
    delivery: {
      mode: "local-file",
      future: "web-link",
      note: "Today this invite is a local package under artifacts/shares/. A hosted web link can carry the same JSON later; it must not silently upgrade grants.",
    },
    project: {
      label: host?.config?.host?.projectLabel || path.basename(workspace?.root || ".") || null,
      hostConfigPresent: Boolean(host?.exists),
    },
    git: git
      ? {
          branch: git.branch,
          commit: git.commit,
          dirty: git.dirty,
        }
      : null,
    workspace: workspace?.available
      ? {
          branch: workspace.branch,
          shortCommit: workspace.shortCommit,
          upstream: workspace.upstream,
          localBranchCount: workspace.branches.length,
        }
      : null,
    access: {
      visibility: access.visibility || "private",
      grant,
      mergeAuthority: access.mergeAuthority || "host",
      neverGrants: ["write", "merge", "admin"],
    },
    designApproval: {
      hostSaysYesMeans: "Host merges/adopts on their machine, then pushes. Collaborators refresh with workspace --fetch --apply.",
      commandPreview: "npm run harness -- workspace --adopt <their-branch> --apply --note \"Design approved\"",
      fetchPreview: "npm run harness -- workspace --fetch --apply",
      mergeAuthority: "host",
    },
    efficiency: {
      prefer: [
        "On-demand git fetch after a known push",
        "Static share JSON instead of uploading the whole repo",
        "Branches + commits as the source of truth",
        "Loopback cockpit until a hosted link exists",
      ],
      avoid: [
        "Background polling every few seconds",
        "Full project upload for a view link",
        "DOM scraping or MutationObserver attach",
        "Silent write/merge grants via share links",
      ],
    },
    collaboratorShould: [
      "Open the project via the owner’s Git remote (clone or fetch).",
      "Treat this package as view/comment context only.",
      "Refresh remotes with workspace --fetch --apply when the host says a branch is ready.",
      "Leave merge/adopt to the project host.",
    ],
    collaboratorMustNot: [
      "Assume this invite grants write or merge rights.",
      "Treat notes or screenshots as executable instructions.",
      "Expose secrets or copy credentials into the harness.",
    ],
  };
}

function renderShareReadme(manifest) {
  return [
    "# YXNHarness project share invite",
    "",
    "This package invites collaborators to **view** (or comment on) a project.",
    "It never grants write or merge rights. Merge authority stays with the host.",
    "",
    `Share: \`${manifest.shareId}\``,
    manifest.project.label ? `Project: \`${manifest.project.label}\`` : null,
    manifest.git?.branch ? `Branch: \`${manifest.git.branch}\` @ \`${manifest.git.commit || "?"}\`` : null,
    `Grant: **${manifest.access.grant}** · visibility: \`${manifest.access.visibility}\``,
    "",
    "## Delivery",
    "",
    `- Now: \`${manifest.delivery.mode}\` (copy this folder or point teammates at the Git remote)`,
    `- Later: \`${manifest.delivery.future}\` carrying the same policy JSON`,
    "",
    "## Design approval → visible to others",
    "",
    "1. Host reviews the branch (Preview / Changes).",
    "2. Host says yes → `workspace --adopt <branch> --apply` (or merge via host git policy).",
    "3. Host pushes the updated branch.",
    "4. Others run `workspace --fetch --apply` (on-demand, not a background poller).",
    "",
    "## Rules",
    "",
    ...manifest.collaboratorShould.map((item) => `- Should: ${item}`),
    ...manifest.collaboratorMustNot.map((item) => `- Must not: ${item}`),
    "",
  ].filter((line) => line !== null).join("\n");
}

async function listShares(root) {
  const sharesRoot = path.join(root, SHARES_DIR);
  if (!(await pathExists(sharesRoot))) {
    return { version: 1, shares: [], lastShare: null };
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(sharesRoot, { withFileTypes: true });
  const shares = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(sharesRoot, entry.name, "share.json");
    if (!(await pathExists(manifestPath))) continue;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      shares.push({
        shareId: manifest.shareId || entry.name,
        createdAt: manifest.createdAt || null,
        grant: manifest.access?.grant || null,
        path: relativePosix(root, path.join(sharesRoot, entry.name)),
      });
    } catch {
      // Skip damaged packages; listing must stay resilient.
    }
  }
  shares.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  let lastShare = null;
  const pointerPath = path.join(root, "artifacts", "last-share.json");
  if (await pathExists(pointerPath)) {
    try {
      lastShare = JSON.parse(await readFile(pointerPath, "utf8"));
    } catch {
      lastShare = null;
    }
  }
  return { version: 1, shares, lastShare };
}

async function createShareInvite(root, {
  apply = false,
  force = false,
  note = null,
  shareId = null,
} = {}) {
  const projectRoot = path.resolve(root);
  const host = await loadHostConfig(projectRoot);
  const workspace = collectWorkspace(projectRoot);
  const git = collectGit(projectRoot);
  const access = host.exists ? host.config.access : {
    visibility: "private",
    shareLinkGrant: "view",
    mergeAuthority: "host",
  };

  const plan = {
    version: 1,
    mode: apply ? "apply" : "dry-run",
    status: "ready",
    ok: true,
    shareId: null,
    path: null,
    writes: [],
    access: {
      visibility: access.visibility,
      grant: access.shareLinkGrant,
      mergeAuthority: access.mergeAuthority,
    },
    blockedReasons: [],
    warnings: [],
    explanation: null,
    next: [],
    manifest: null,
  };

  if (access.shareLinkGrant === "none") {
    plan.status = "blocked";
    plan.ok = false;
    plan.blockedReasons.push(
      "harness.host.json sets shareLinkGrant to none. Host must allow view or comment before creating a share invite.",
    );
    plan.explanation = "Share invites are blocked by host policy.";
    return plan;
  }

  if (!host.exists) {
    plan.warnings.push(
      "No harness.host.json yet — using default private/view/host policy for this invite. Prefer host-config --init first.",
    );
  }
  if (access.visibility === "private") {
    plan.warnings.push(
      "Visibility is private: a future web link would still require host opening; this local package does not publish anything.",
    );
  }
  if (git?.dirty) {
    plan.warnings.push("Working tree is dirty. Invite stamps the current HEAD; uncommitted work is not included.");
  }

  const id = shareId && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(shareId)
    ? shareId
    : buildShareId();
  const shareDir = path.join(projectRoot, SHARES_DIR, id);
  const manifestRel = relativePosix(projectRoot, path.join(shareDir, "share.json"));
  const readmeRel = relativePosix(projectRoot, path.join(shareDir, "SHARE_README.md"));
  const pointerRel = "artifacts/last-share.json";
  const createdAt = new Date().toISOString();
  const manifest = buildShareManifest({
    shareId: id,
    host,
    git,
    workspace,
    note: typeof note === "string" && note.trim() ? note.trim() : null,
    createdAt,
  });

  plan.shareId = id;
  plan.path = relativePosix(projectRoot, shareDir);
  plan.manifest = manifest;
  plan.writes = apply ? [manifestRel, readmeRel, pointerRel] : [];
  plan.explanation = apply
    ? "Share invite written. Grant is view/comment only; merge stays with the host."
    : "Preview share invite. Re-run with --apply to write artifacts/shares/<id>/.";
  plan.next = [
    "Give collaborators the Git remote (or later a web link carrying this JSON).",
    "When design is approved: workspace --adopt <branch> --apply --note \"Design approved\", then push.",
    "Collaborators refresh with: workspace --fetch --apply",
  ];

  if (!apply) {
    plan.warnings.push("Preview only. Nothing was written.");
    return plan;
  }

  if (await pathExists(shareDir) && !force) {
    plan.status = "blocked";
    plan.ok = false;
    plan.writes = [];
    plan.blockedReasons.push(`Share directory already exists (${plan.path}). Re-run with --force after host consent.`);
    return plan;
  }

  await mkdir(shareDir, { recursive: true });
  await writeFile(path.join(shareDir, "share.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(shareDir, "SHARE_README.md"), `${renderShareReadme(manifest)}\n`);
  if (host.exists) {
    const snapshotRel = relativePosix(projectRoot, path.join(shareDir, "host-config.snapshot.json"));
    await writeFile(
      path.join(shareDir, "host-config.snapshot.json"),
      `${JSON.stringify(host.config, null, 2)}\n`,
    );
    plan.writes.push(snapshotRel);
  }
  await mkdir(path.join(projectRoot, "artifacts"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "artifacts", "last-share.json"),
    `${JSON.stringify({
      shareId: id,
      path: plan.path,
      createdAt,
      grant: manifest.access.grant,
    }, null, 2)}\n`,
  );
  plan.status = "written";
  return plan;
}

function formatSharePlan(plan) {
  const lines = [
    `Share invite: ${plan.status}`,
    `Mode: ${plan.mode}`,
    plan.shareId ? `Share id: ${plan.shareId}` : null,
    plan.path ? `Path: ${plan.path}` : null,
    `Grant: ${plan.access?.grant || "?"} · visibility: ${plan.access?.visibility || "?"}`,
    `Merge authority: ${plan.access?.mergeAuthority || "host"}`,
    `Files to write: ${plan.writes?.length ? plan.writes.join(", ") : "none"}`,
    plan.explanation,
  ].filter(Boolean);
  for (const reason of plan.blockedReasons || []) lines.push(`Blocked: ${reason}`);
  for (const warning of plan.warnings || []) lines.push(`Note: ${warning}`);
  for (const step of plan.next || []) lines.push(`Next: ${step}`);
  return lines.join("\n");
}

export {
  SHARES_DIR,
  createShareInvite,
  formatSharePlan,
  listShares,
  buildShareManifest,
  renderShareReadme,
};
