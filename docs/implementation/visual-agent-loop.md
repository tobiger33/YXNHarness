# Visual feedback → agent → review

Status: Harbor Desk playthrough ready on this repo — live inspector Select (Kommentieren/Übernehmen), attachment transport, `workspace-edit` opt-in in `harness.host.json`, propose → Preview → Accept, and YXN commit/merge gate. Remote model adapters remain project-specific.
Owner split: UI/layout in Codex; backend and native target adapters in Cursor.
Keep the accepted YXNHarness layout and native application behavior.

**Who does what:** the coding agent installs, starts cockpit + app, attaches,
and leaves proposals. The host only Previews/Accepts/Rejects (and merge
Accept). Do not treat the acceptance checklist below as a host chore list —
agents execute it; hosts decide.

## First application

Use `examples/foreign-booking` as the reproducible integration fixture before
connecting a user repository. It is a separate application with a native store
and three screens (search → review → done), Back and reset. Product actions are
already implemented in `app.js` / `store.js`; the opt-in `harness-adapter.js`
exposes semantic state. There is no live element inspector yet.

For a user application, provide its repository, running development URL and
opt-in adapter. Do not replace it with the PULS example or assume a frontend stack.

## Accepted interaction

1. Open the repository and its running app through Open app.
2. Interact is the default. Navigate all pages, fill forms, use Back and Submit.
3. Activate Select explicitly. Choose an element; normal clicks in Interact
   must never attach context or trigger an agent action.
4. The selection toolbar offers Kommentieren / Übernehmen and Clear.
5. Either action focuses the existing composer, preserves its draft and reveals
   the right panel if collapsed. The context card shows element, original route,
   source revision/branch and target branch. The user adds free-form instructions.
6. Sending a comment saves element-scoped feedback. Sending Übernehmen creates
   an adaptation request using the existing dry-run/apply element endpoint.
   This does not itself edit code, merge a branch or run a model.
7. The future real agent reports activity and proposed files. The user reviews
   Changes and the running Preview before accepting an implementation.

Screenshots appear as thumbnails and reopen from composer/message. Drafts retain
local Blob storage and upload to the attachment API before sending. Server
storage alone does not send pixels to a model; that requires an image-capable adapter.

## Already implemented: reuse these

- `POST /api/v1/feedback`: body, route, viewport, branch, commit, element, source,
  screenshot and run identity. See `schema/feedback.schema.json`.
- `POST /api/v1/elements/adopt`: elements, sourceBranch/sourceCommit, route,
  viewport, body, apply, withHandoff. Uses dry-run first; withHandoff is false
  unless the user explicitly requests a handoff.
- Native frame navigation: `cockpit/preview.js`.
- Selection toolbar and composer summary: `cockpit/app.js`, demonstrated in the
  built-in multi-page PULS example. Selection context is stored locally.
- Screenshot viewer and local draft storage: `cockpit/attachments.js`.
- Agent capability declaration: `schema/agent-adapter.schema.json`; do not show
  unsupported model, streaming or file-edit features as connected.

## Cursor work package: live inspector

Implement an explicit development-only adapter in the target's own component
and routing APIs. Enable it only through the target's opt-in mechanism. Use
stable element IDs owned by the app, semantic screen state and native router
location, not scraped text, selectors guessed from screenshots, or DOM rewriting.

The UI adapter boundary must provide:

- Readiness and capabilities (selection, route reporting, screenshots if real).
- Selection mode enter/leave with acknowledgement; Escape always returns to
  normal interaction. No always-on click interception in the target app.
- Selected element identity, label, native route, source revision/branch, viewport
  and its rectangle in **frame viewport CSS pixels**.
- Selection invalidation if the element unmounts, the route changes, the preview
  reloads or the adapter disconnects. Existing draft context keeps its original
  source identity; a stale visual highlight must disappear.
- Route updates for every screen, including client-side routes, browser Back,
  hash routes and full document navigation. Frame load alone is not readiness.

For cross-origin previews use a versioned, session-bound postMessage protocol.
Both sides must verify exact origin, source window and session nonce; reject
malformed/oversized data. A source branch must come from the preview's trusted
workspace mapping, not an arbitrary value supplied by page content. The target
must not gain Git/merge/API credentials. Selection content remains untrusted data.

**Event envelope (draft implemented):**
`{ protocol: "yxn.preview", version: 1, sessionId, type, requestId?, payload }`
Types: ready, capabilities, set-mode, mode-changed, route-changed,
element-selected, selection-cleared, preview-style, clear-preview-style,
preview-style-changed, error. Confirm the contract with the UI team before
treating it as frozen. Host: `cockpit/preview.js` + `preview-protocol.js`.
Fixture adapter: `examples/foreign-booking/preview-inspector.js`. Live Select
stays disabled until the adapter advertises `selection: true` and the host
acknowledges it. `stylePreview: true` enables temporary proposal CSS in the
live app. Details: [`preview-inspector.md`](../preview-inspector.md).

## Cursor work package: attachment transport

Implemented surface:

- `POST /api/v1/attachments` → id, filename, MIME type, byte size, dimensions,
  project identity and a same-origin read URL (`contentUrl`).
- `GET /api/v1/attachments` → list stored attachment metadata.
- `GET /api/v1/attachments/:id/content` → the original image bytes.
- `DELETE /api/v1/attachments/:id` → remove an unreferenced draft attachment
  (`?force=1` after host consent when feedback still references it).

Validation uses magic-byte sniffing (PNG/JPEG/WebP/GIF), the UI limit of
6 images / 12 MB per image, and rejects mismatched declared Content-Type.
Images live under `artifacts/attachments/<id>/` and stay out of logs.
Feedback identity/messages accept `attachmentIds`; delete refuses referenced
ids unless forced. Cockpit uploads Blobs, shows upload/error/retry, and clears
draft IndexedDB after a successful send while message thumbnails keep content
URLs. An agent receives pixels only when its adapter supports images.

## Acceptance run (required before claiming end-to-end completion)

1. Open Harbor Desk, fill city/nights, go Review, Back, Confirm and New search.
   Zero automatic context selection in Interact; no target behavior changed.
2. Enable Select on each screen. Choose Review/Confirm/New search separately.
   Toolbar and context card reflect the correct element and original route.
3. Add instructions, switch Home → workspace, toggle panels and revisit screens.
   Draft, context identity and native app state survive.
4. Comment: verify the persisted feedback identity against actual source/target
   revisions. Übernehmen: dry-run then apply; verify it creates feedback, not a merge.
5. Upload a screenshot, open it, send, reload and reopen from the stored message.
   Removing a draft thumbnail must not break an already sent image reference.
6. This repo’s `harness.host.json` already sets `agent.adapter: "workspace-edit"`.
   Send a turn, inspect the quiet timeline + Edited diff, Preview in Harbor Desk,
   then Accept (or Reject). Automated coverage:
   `node --test tests/harness.test.mjs` (workspace-edit propose/accept) and
   `node --test tests/cockpit-harbor-loop.test.mjs` (live Select → Accept).
7. Exercise missing adapter, disconnected app, stale selection, rejected upload,
   failed request, retry, fast route changes, keyboard access and narrow screens.

UI regression tests:
`HARNESS_BROWSER_CHANNEL=chrome node --test tests/cockpit-preview.test.mjs tests/cockpit-harbor-loop.test.mjs`
Omit `HARNESS_BROWSER_CHANNEL` when the installed Playwright Chromium is used.

Playthrough (two terminals):
1. `npm run harness -- serve` → open the printed cockpit URL
2. `node examples/foreign-booking/server.mjs` (default `http://127.0.0.1:4173/`)
3. Open app (URL prefilled from `harness.config.json`) → wait for “Live inspector ready”
4. Interact through Harbor Desk, then Select → Kommentieren → send → Preview → Accept
5. Changes → Commit (trailer `Summary written by YXN.`) when you want the edit on a branch

## UI update: rectangle groups

Example Select supports drag rectangles and additive clicks/groups by default.
Clicking a selected element toggles only that member. Selections accumulate
across screens; explicit Clear removes the full group. The
composer retains every member ID, route and source identity; adaptation uses
an elements array, grouped by original route and source revision when calling
the current single-route backend endpoint. Group comments currently retain members under
`identity.appState.selectedElements` alongside the primary element identity.
The live inspector contract must support equivalent multi-selection payloads
rather than reducing a dragged group to a single element.

## UI update: screenshot sizing contract

Local attachment metadata now includes `image.{width,height,unit:"px"}` plus,
for native project captures, `viewport.{width,height,unit:"css-px",kind}`,
`devicePixelRatio`, `captureRect` (CSS pixels and offset), `imageToCssScale`,
`capturedAt`, and `route`. Uploaded images report unknown viewport/DPR; never
infer CSS size from raster dimensions. External task text and feedback
`identity.appState.screenshotAttachments` already carry this context. Preserve
these fields alongside server attachment IDs and content URLs. The agent
should target the recorded CSS viewport and use image pixels as visual evidence.
