# Workspace (local Git context)

Branches are the isolated workspaces for harness work. This slice exposes a
**read-only** inventory of the current checkout and local branches so the
cockpit (and agents) can reason about where evidence came from.

No checkout, create, or push commands are offered here yet. Those remain
host-controlled.

## CLI

```sh
npm run harness -- workspace
npm run harness -- workspace --json
npm run harness -- status --json
```

`workspace` prints the current branch/revision, dirty state, upstream drift
when available, and the local branch list.

`status` includes the same snapshot under `workspace` alongside host policy and
the run index.

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

## What this is not

- Not `git checkout` / branch create / push
- Not hosted preview binding
- Not a substitute for the coding agent's own Git UI

See also [`vision.md`](vision.md) and [`cockpit-foundation.md`](cockpit-foundation.md).
