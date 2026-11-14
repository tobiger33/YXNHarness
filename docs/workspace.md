# Workspace (local Git context)

Branches are the isolated workspaces for harness work. The harness exposes a
local inventory plus **host-controlled** create/switch/review/adopt for local
branches.

Fetch and push stay outside this CLI — use the coding agent's Git tools or plain
`git` for remotes.

## Inventory

```sh
npm run harness -- workspace
npm run harness -- workspace --json
npm run harness -- status --json
```

Shows the current branch/revision, dirty state, upstream drift when available,
and the local branch list.

## Create (local only)

```sh
npm run harness -- workspace --create feature/demo --dry-run
npm run harness -- workspace --create feature/demo --apply
npm run harness -- workspace --create feature/demo --start main --apply
```

Creates a new local branch from `HEAD` (or `--start <existing-local-branch>`) and
switches onto it. Refuses if the name already exists.

## Checkout (local only)

```sh
npm run harness -- workspace --checkout feature/demo --dry-run
npm run harness -- workspace --checkout feature/demo --apply
```

Preview by default (`--dry-run` or omit `--apply`). `--apply` runs
`git switch` onto an **existing local** branch.

## Review (diff, GitHub-style)

```sh
npm run harness -- workspace --review feature/demo
npm run harness -- workspace --review feature/demo --path src/app.js --json
```

Compares **your** current branch to **theirs** with a three-dot diff
(`HEAD...theirs`) — the same shape GitHub uses for a PR file list: changes on
their branch since the merge-base.

Returns file list + `+`/`-` counts. With `--path`, includes the unified patch
for that file.

## Adopt (merge / files / hunks)

### Whole branch

```sh
npm run harness -- workspace --adopt feature/demo --dry-run
npm run harness -- workspace --adopt feature/demo --apply
npm run harness -- workspace --adopt feature/demo --apply --note "Keep layout; tweak copy later"
```

Merges **their** local branch into **your** current branch.
This is the CLI equivalent of the cockpit **Übernehmen** flow.

Optional `--note` is host/agent context (not instructions). When present it is
written into a merge commit (`git merge --no-ff -m …`). Without a note, a normal
fast-forward-capable merge is used.

### Selected files

```sh
npm run harness -- workspace --adopt feature/demo --path src/app.js --dry-run
npm run harness -- workspace --adopt feature/demo --path src/app.js --path src/styles.css --apply
```

Checks out (or deletes) only those paths from **theirs** into your index.
No merge commit — review with `git status` / `git diff --cached`, then commit.

### Selected hunks

```sh
npm run harness -- workspace --review feature/demo --path src/app.js
npm run harness -- workspace --adopt feature/demo --path src/app.js --hunks 1,3 --dry-run
npm run harness -- workspace --adopt feature/demo --path src/app.js --hunks 1,3 --apply
```

Applies 1-based unified-diff hunks from the three-dot patch into the index.
Hunk adopt supports **modified** files only; added/deleted/renamed files use
whole-file `--path` adopt.

Guards (create + checkout + adopt):

- Unknown / unsafe branch names → blocked
- Dirty working tree → blocked unless the host consents with `--force`
- Already on the target (checkout/adopt) → `noop`
- Merge conflicts / patch rejects → blocked; resolve with plain `git` (no auto-resolve)
- Paths must appear in the review file list
- No fetch, push, or upstream setup

## Run stamps

Each scenario `result.json` includes a compact `git` object when the project is
a repository:

```json
{
  "git": {
    "branch": "feature/demo",
    "commit": "abc123…",
    "dirty": false
  }
}
```

Handoff manifests reuse the same stamp. The run index surfaces `git` per run
when present.

## Cockpit API

```sh
npm run harness -- serve
```

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/workspace` | Full workspace snapshot + local branches |
| GET | `/api/v1/workspace/review?ref=&path=` | Review file list (+ optional patch) |
| POST | `/api/v1/workspace/adopt` | `{ ref, apply?, force?, paths?, path?, hunks?, comment? }` — loopback only |
| POST | `/api/v1/workspace/fetch` | `{ apply?, remote?, prune? }` — on-demand remote refresh |
| GET | `/api/v1/overview` | Includes a short `workspace` summary |

Adopt body modes:

- omit `paths` → whole-branch merge
- `paths: ["a.js"]` (or `path`) → file adopt into the index
- `path` + `hunks: [1,3]` → hunk adopt into the index

## Fetch (refresh remotes)

```sh
npm run harness -- workspace --fetch --dry-run
npm run harness -- workspace --fetch --apply
npm run harness -- workspace --fetch --remote origin --apply
```

Updates remote-tracking refs only (optional prune). No checkout, merge, or push.
Prefer on-demand fetch after a known push — see [`share.md`](share.md).

Adopt and fetch are the git write routes on `serve`. Checkout/create stay on the CLI.

## What this is not

- Not push / upstream setup (fetch is supported; push stays plain git)
- Not hosted preview binding
- Not interactive `git checkout -p` / conflict auto-resolve
- Not a substitute for the coding agent's own Git UI
- Not a background poller

See also [`vision.md`](vision.md), [`share.md`](share.md), and
[`cockpit-foundation.md`](cockpit-foundation.md).
