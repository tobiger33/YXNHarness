# Visual element adopt

Record host intent to bring selected UI elements from a **source** branch/context
into **your** current branch — as element-scoped feedback (and optional handoff).

This does **not** rewrite UI trees or invent product behavior. It creates durable
context for a coding agent (comments are never executable instructions).

## Easy path

```sh
npm run harness -- elements --adopt --element ContinueButton --source-branch feature/onboarding --dry-run
npm run harness -- elements --adopt --element ContinueButton --source-branch feature/onboarding --apply
npm run harness -- elements --adopt --element ContinueButton --element WealthWidget --apply --with-handoff
```

In the cockpit Compare view: select elements → **Elemente übernehmen**.

## What gets stored

Each selected element becomes a feedback thread with:

| Field | Meaning |
|-------|---------|
| `identity.branch` / `commit` | **Yours** — where the element should land |
| `identity.element` | Selected element id / kind / label |
| `identity.source.branch` | Source branch (where the pick came from) |
| `identity.source.elementId` | Same element id for later matching |

A manifest is written under `artifacts/element-adopts/<adoptId>.json`.

With `--with-handoff`, threads are bundled into a normal handoff package.

## API

```http
POST /api/v1/elements/adopt
{
  "elements": [{ "id": "ContinueButton", "kind": "harness", "source": { "branch": "feature/onboarding" } }],
  "body": "optional note",
  "sourceBranch": "feature/onboarding",
  "apply": true,
  "withHandoff": false
}
```

## Relation to file/hunk adopt

| | Files / hunks | Elements |
|--|---------------|----------|
| Input | Git paths / unified-diff hunks | Visual element ids |
| Effect | Updates the git index | Creates feedback (+ optional handoff) |
| CLI | `workspace --adopt --path` | `elements --adopt --element` |

See also [`feedback.md`](feedback.md), [`workspace.md`](workspace.md), [`handoff.md`](handoff.md).
