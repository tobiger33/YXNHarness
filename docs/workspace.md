# Workspace (native YXN Git loop)

Branches are the isolated workspaces for harness work — including branches from
multiple people. YXN owns the native loop: create → checkout → review → commit
→ push → merge-propose → host/leader Accept → fetch.

Remote-tracking refs (e.g. `origin/alice/hero`) appear after fetch and can be
reviewed, tracked locally, or proposed for merge without leaving YXN.

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

## Checkout (local or remote-tracking)

```sh
npm run harness -- workspace --checkout feature/demo --dry-run
npm run harness -- workspace --checkout feature/demo --apply
npm run harness -- workspace --checkout origin/alice/hero --apply
```

Preview by default (`--dry-run` or omit `--apply`). Local refs use `git switch`.
Remote-tracking refs create/track a local branch (`git switch -c … --track`).

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
| POST | `/api/v1/workspace/adopt` | `{ ref, apply?, force?, paths?, path?, hunks?, comment? }` — local or remote-tracking ref |
| POST | `/api/v1/workspace/checkout` | `{ ref\|branch, apply?, force? }` — switch local or track remote |
| POST | `/api/v1/workspace/create` | `{ branch, from?, apply?, force? }` — create + switch |
| POST | `/api/v1/workspace/approve` | `{ ref, apply?, force?, note?, role? }` — design approve (propose+Accept; YXN summary) |
| POST | `/api/v1/workspace/commit` | `{ message\|summary, apply?, paths? }` — commit dirty tree; always appends `Summary written by YXN.` |
| GET | `/api/v1/workspace/merge-proposals` | `?status=pending` — list merge proposals + host/leader policy |
| POST | `/api/v1/workspace/merge-proposals` | `{ ref, summary?, apply? }` — queue merge for host/leader Accept |
| POST | `/api/v1/workspace/merge-proposals/:id/accept` | `{ role?: "host"\|"leader", apply? }` — Accept gated merge |
| POST | `/api/v1/workspace/merge-proposals/:id/reject` | `{ role?, reason? }` — Reject gated merge |
| POST | `/api/v1/workspace/push` | `{ apply?, remote?, force? }` — push current branch (force = force-with-lease) |
| POST | `/api/v1/workspace/fetch` | `{ apply?, remote?, prune? }` — on-demand remote refresh |
| GET | `/api/v1/overview` | Includes a short `workspace` summary + `host.mergePolicy` |

Adopt body modes:

- omit `paths` → whole-branch merge
- `paths: ["a.js"]` (or `path`) → file adopt into the index
- `path` + `hunks: [1,3]` → hunk adopt into the index

## Commit (YXN summary)

```sh
npm run harness -- workspace --commit --note "Hero spacing" --dry-run
npm run harness -- workspace --commit --note "Hero spacing" --apply
```

The harness always appends `Summary written by YXN.` to the commit message.

## Merge proposals (host / leader Accept)

Merges proposed through YXN do not run until the host — or a configured
`access.leader` — Accepts. Share links never grant merge.

```sh
npm run harness -- workspace --merge-propose feature/demo --note "Ship onboarding" --apply
npm run harness -- workspace --merge-accept merge-<id> --role host
# with harness.host.json access.leader.label set:
npm run harness -- workspace --merge-accept merge-<id> --role leader
```

Optional host config:

```json
{
  "access": {
    "visibility": "private",
    "shareLinkGrant": "view",
    "mergeAuthority": "leader",
    "leader": { "label": "Design lead" }
  }
}
```

`mergeAuthority: "leader"` marks the leader as preferred Approver; the host can
always Accept. Without `leader`, only the host can Accept.

## Design approve

Whole-branch host/leader Accept with a YXN-attributed summary. No push.
Creates a merge proposal and Accepts it in one step (Design passt).

```sh
npm run harness -- workspace --approve feature/demo --dry-run
npm run harness -- workspace --approve feature/demo --apply
npm run harness -- workspace --approve feature/demo --apply --note "Design approved · keep copy"
npm run harness -- workspace --approve feature/demo --apply --role leader
```

Cockpit Changes: **Design passt** → `POST /api/v1/workspace/approve`.
**Merge vorschlagen** queues a pending proposal for host/leader Accept.
After Accept, the UI offers **Push** then **Remotes aktualisieren**.

## Push (publish current branch)

Host-controlled push of the current branch. No network until `--apply`.
Never plain `--force` or `--delete` — `--force` maps to `--force-with-lease`.

```sh
npm run harness -- workspace --push --dry-run
npm run harness -- workspace --push --apply
npm run harness -- workspace --push --remote origin --apply
npm run harness -- workspace --push --force --apply   # force-with-lease only
```

If there is no upstream yet, push sets `-u <remote> <branch>`.

## Fetch (refresh remotes)

```sh
npm run harness -- workspace --fetch --dry-run
npm run harness -- workspace --fetch --apply
npm run harness -- workspace --fetch --remote origin --apply
```

Updates remote-tracking refs only (optional prune). No checkout, merge, or push.
Prefer on-demand fetch after a known push — see [`share.md`](share.md).

Checkout, create, adopt, approve, commit, merge-propose/accept, push, and fetch
are all available on `serve` so multi-person branch work stays inside YXN.
Other local writes (feedback, element adopt, attach, share) are documented in
[`cockpit-api.md`](cockpit-api.md).

## What this is not

- Not remote create / delete / plain `--force` (push uses force-with-lease only)
- Not hosted preview binding
- Not interactive `git checkout -p` / conflict auto-resolve
- Not a substitute for the coding agent's own Git UI
- Not a background poller

See also [`vision.md`](vision.md), [`share.md`](share.md), and
[`cockpit-foundation.md`](cockpit-foundation.md).
