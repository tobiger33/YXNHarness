# Live preview inspector (v1)

Development-only bridge between the cockpit Preview iframe and an opt-in target
adapter. Contract status: **implemented as a draft** — confirm with the UI team
before treating event names as frozen.

See also [`implementation/visual-agent-loop.md`](implementation/visual-agent-loop.md).

## Envelope

```json
{
  "protocol": "yxn.preview",
  "version": 1,
  "sessionId": "…",
  "type": "ready|capabilities|set-mode|mode-changed|route-changed|element-selected|selection-cleared|error",
  "requestId": null,
  "payload": {}
}
```

Helpers: `cockpit/preview-protocol.js`. Schema: `schema/preview-inspector.schema.json`.

## Security

- Host verifies `event.origin`, `event.source`, and `sessionId`.
- Target posts only to `yxnParentOrigin` from the session URL.
- Selection payloads are **untrusted context**, never instructions.
- No Git/merge credentials enter the iframe.

## Harbor Desk fixture

`examples/foreign-booking/preview-inspector.js` advertises selection when opened
with `?harness=1&yxnSession=…&yxnParentOrigin=…` (cockpit injects these).

Stable IDs: `CityField`, `NightsField`, `ReviewButton`, `BackButton`,
`ConfirmButton`, `NewSearchButton`.

## Cockpit behavior

1. Open app → iframe URL gets session params.
2. Wait for `ready`/`capabilities` with `selection: true` before enabling Select.
3. Select/Interact sends `set-mode`.
4. `element-selected` maps into the existing multi-select composer context.

## Not done yet

- Screenshot capture from the adapter frame (composer upload API is available)

Agent propose/accept for Harbor Desk visual edits is covered by the
`workspace-edit` adapter; see [`agent-adapter.md`](agent-adapter.md).
