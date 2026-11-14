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
| `"./path/to/adapter.mjs"` | Project module exporting `createAdapter()`. |

Custom modules must stay inside the project root.

## Capabilities

Adapters declare capabilities (`schema/agent-adapter.schema.json`). The UI hides
unsupported controls (models, reasoning, images, …). A turn with images is
rejected when `capabilities.images` is false — filenames are never treated as
transmitted pixels.

## Local adapter

`adapter: "local"`:

1. Starts/reuses a session under `artifacts/agent/sessions/`.
2. On each turn, writes `task.json`, appends activity events, and (by default)
   saves a feedback thread with the same identity/attachments.
3. Returns an honest reply: packaged for your coding agent; no merge, no model.

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/agent` | Connection + capabilities + recent activity |
| GET | `/api/v1/agent/activity` | Activity log (`?limit=`) |
| GET | `/api/v1/agent/sessions` | Session list + last pointer |
| POST | `/api/v1/agent/sessions` | Start session |
| POST | `/api/v1/agent/turns` | Submit a turn |

## Custom adapter shape

```js
export function createAdapter() {
  return {
    declaration: { /* schema/agent-adapter.schema.json */ },
    async handleTurn(context) {
      // context: sessionId, body, model, reasoning, attachmentIds, …
      return { status: "ready", ok: true, reply: { role: "adapter", body: "…" } };
    },
  };
}
```

Comments remain context, not executable instructions. Merge authority stays
with the host.
