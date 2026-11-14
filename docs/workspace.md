# Workspace (local Git context)

Branches are the isolated workspaces for harness work. The harness exposes a
local inventory plus **host-controlled** create/switch for local branches.

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

Guards (create + checkout):

- Unknown / unsafe branch names → blocked
- Dirty working tree → blocked unless the host consents with `--force`
- Already on the checkout target → `noop`
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

## Read API

```sh
npm run harness -- serve
```

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/workspace` | Full workspace snapshot + local branches |
| GET | `/api/v1/overview` | Includes a short `workspace` summary |

Checkout stays on the CLI for now (no write routes on `serve`).

## What this is not

- Not fetch / push / upstream setup
- Not hosted preview binding
- Not a substitute for the coding agent's own Git UI

See also [`vision.md`](vision.md) and [`cockpit-foundation.md`](cockpit-foundation.md).
