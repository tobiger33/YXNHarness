# Agent adapter

Optional, provider-neutral connection between the cockpit composer and a coding
agent. Solo local feedback needs no adapter.

## Opt in

In `harness.host.json`:

```json
{
  "agent": { "adapter": "local" }
}
```

| Value | Meaning |
|-------|---------|
| omit / `null` | Disconnected (default). Composer writes local feedback only. |
| `"local"` | Built-in task packager. No remote model, no source edits. |
| `"workspace-edit"` | Built-in demo editor. Proposes reversible visual file changes; host Accept required before write. |
| `"./path/to/adapter.mjs"` | Project module exporting `createAdapter()`. |

Custom modules must stay inside the project root.

## Capabilities

Adapters declare capabilities (`schema/agent-adapter.schema.json`). The UI hides
unsupported controls (models, reasoning, images, file changes, …). A turn with
images is rejected when `capabilities.images` is false — filenames are never
treated as transmitted pixels.

## Local adapter

`adapter: "local"`:

1. Starts/reuses a session under `artifacts/agent/sessions/`.
2. On each turn, writes `task.json`, appends activity events, and (by default)
   saves a feedback thread with the same identity/attachments.
3. Returns an honest reply: packaged for your coding agent; no merge, no model.

## Workspace-edit adapter

`adapter: "workspace-edit"`:

1. Packages the turn like `local` (session, activity, optional feedback thread).
2. Builds a reversible visual proposal against Harbor Desk
   (`examples/foreign-booking/styles.css` accent token).
3. Writes the proposal under `artifacts/agent/proposals/<id>/` with unified
   diffs. **No project source is modified yet.**
4. Cockpit shows Accept / Reject. Accept applies the stored after-bodies when
   the on-disk files still match the proposal’s before snapshot (or `force`
   after host consent). Reject leaves source untouched.
5. Merge/push remain host-controlled.

This stays solo-local: no hosted LLM is required. Custom adapters can propose
other files with the same Accept gate.

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/agent` | Connection + capabilities + recent activity + pending proposals |
| GET | `/api/v1/agent/activity` | Activity log (`?limit=`) |
| GET | `/api/v1/agent/sessions` | Session list + last pointer |
| POST | `/api/v1/agent/sessions` | Start session |
| POST | `/api/v1/agent/turns` | Submit a turn |
| GET | `/api/v1/agent/proposals` | List proposals (`?status=pending`) |
| GET | `/api/v1/agent/proposals/:id` | Proposal detail + diffs |
| POST | `/api/v1/agent/proposals/:id/accept` | Host Accept → write files |
| POST | `/api/v1/agent/proposals/:id/reject` | Host Reject |

## Custom adapter shape

```js
export function createAdapter() {
  return {
    declaration: { /* schema/agent-adapter.schema.json */ },
    async handleTurn(context) {
      // context: sessionId, body, model, reasoning, attachmentIds, …
      return {
        status: "awaiting-approval",
        ok: true,
        reply: { role: "adapter", body: "…" },
        proposals: [/* optional public proposals */],
      };
    },
  };
}
```

Comments remain context, not executable instructions. Merge authority stays
with the host.
