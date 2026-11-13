# Workspace (local Git context)

Branches are the isolated workspaces for harness work. The harness exposes a
local inventory plus a **host-controlled** switch onto an existing local branch.

Create, fetch, and push stay outside this CLI — use the coding agent's Git tools
or plain `git` for those.

## Inventory

```sh
npm run harness -- workspace
npm run harness -- workspace --json
npm run harness -- status --json
```

Shows the current branch/revision, dirty state, upstream drift when available,
and the local branch list.

## Checkout (local only)

```sh
npm run harness -- workspace --checkout feature/demo --dry-run
npm run harness -- workspace --checkout feature/demo --apply
```

Preview by default (`--dry-run` or omit `--apply`). `--apply` runs
`git switch` onto an **existing local** branch.

Guards:

- Unknown / unsafe branch names → blocked
- Dirty working tree → blocked unless the host consents with `--force`
- Already on the target → `noop`
- No branch create, no remote tracking setup, no push/fetch

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

- Not branch create / fetch / push
- Not hosted preview binding
- Not a substitute for the coding agent's own Git UI

See also [`vision.md`](vision.md) and [`cockpit-foundation.md`](cockpit-foundation.md).
