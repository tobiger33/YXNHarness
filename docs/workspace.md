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

## Adopt (merge into yours)

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

Guards (create + checkout + adopt):

- Unknown / unsafe branch names → blocked
- Dirty working tree → blocked unless the host consents with `--force`
- Already on the target (checkout/adopt) → `noop`
- Merge conflicts → blocked; resolve with plain `git` (no auto-resolve)
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
| POST | `/api/v1/workspace/adopt` | `{ ref, apply?, force? }` — loopback only |
| GET | `/api/v1/overview` | Includes a short `workspace` summary |

Adopt is the only write route on `serve`. Checkout/create stay on the CLI.

## What this is not

- Not fetch / push / upstream setup
- Not hosted preview binding
- Not per-hunk cherry-pick yet (whole-branch merge first)
- Not a substitute for the coding agent's own Git UI

See also [`vision.md`](vision.md) and [`cockpit-foundation.md`](cockpit-foundation.md).
