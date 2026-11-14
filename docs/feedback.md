# Feedback threads

Local, persistent visual feedback that anchors comments to a revision and
optional UI context. No account and no LLM provider required.

## Easy path

```sh
npm run harness -- feedback --create --body "Tighten the primary CTA" --route / --viewport desktop --apply
npm run harness -- feedback --list --json
npm run harness -- feedback --id <threadId> --resolve --apply
npm run harness -- feedback --bundle <threadId> --from last-green --apply
```

In the cockpit (`npm run harness -- serve`), use the right **Agent** panel:
write feedback, select threads, **Bundle handoff**. The panel shows
**Local · not connected** until a real agent adapter exists — nothing is faked.

## Identity

Each thread stores stable identity fields for later multi-branch visual work:

| Field | Meaning |
|-------|---------|
| `branch` / `commit` | Workspace revision when the note was created |
| `route` / `viewport` | Screen context |
| `element.id` | Selected UI element (harness / selector / path / label) |
| `source.{branch,commit,elementId}` | Origin for future “take this element into my branch” |
| `runId` / `screenshot` / `appState` | Optional evidence links |
| `attachmentIds` | Server image ids from `POST /api/v1/attachments` (also on messages) |

Comments are **context**, never executable instructions. Images are referenced
by id only; bytes stay under `artifacts/attachments/`.

## Storage

```
artifacts/feedback/
  index.json
  threads/<threadId>.json
```

## Bundle → handoff

Bundling writes a normal handoff package plus `feedback-threads.json`, patches
`manifest.feedback`, and marks threads `bundled`. Give that folder to your
coding agent.

## Agent adapters (later)

See `schema/agent-adapter.schema.json`. Connected agents must declare
capabilities (models, streaming, file changes, …). Unsupported UI is not shown.
Activity (reads, diffs, previews) will land in the Agent panel when an adapter
is connected.

## Element adopt

To take Compare/Preview picks into your branch as element-scoped threads:

```sh
npm run harness -- elements --adopt --element ContinueButton --source-branch feature/x --apply
```

See [`elements.md`](elements.md).

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/feedback` | List |
| GET | `/api/v1/feedback/:id` | Detail |
| POST | `/api/v1/feedback` | Create (`apply` default true) |
| PATCH | `/api/v1/feedback/:id` | Append body / set `open`\|`done` |
| POST | `/api/v1/feedback/bundle` | Bundle into handoff |
| POST | `/api/v1/elements/adopt` | Visual element adopt → feedback (+ optional handoff) |
| POST | `/api/v1/attachments` | Upload image; returns `attachmentId` + `contentUrl` |
| GET | `/api/v1/attachments/:id/content` | Read stored image |
| DELETE | `/api/v1/attachments/:id` | Delete unreferenced draft |
| GET | `/api/v1/agent` | Honest connection stub |

See also [`handoff.md`](handoff.md), [`elements.md`](elements.md), and [`vision.md`](vision.md).
