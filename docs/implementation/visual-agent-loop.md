# Visual feedback → agent → review

Status: UI preparation implemented; live inspector and attachment transport pending.
Owner split: UI/layout in Codex; backend and native target adapters in Cursor.
Keep the accepted YXNHarness layout and native application behavior.

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

Screenshots appear as thumbnails and reopen from composer/message. Local Blob
storage is already implemented; it is not server storage or a model upload.

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

**Proposed event envelope (not implemented yet):**
`{ protocol: "yxn.preview", version: 1, sessionId, type, requestId?, payload }`
Types: ready, capabilities, set-mode, mode-changed, route-changed,
element-selected, selection-cleared, error. Confirm the contract with the UI
team before treating it as an existing protocol. The UI team will map adapter
rectangles to its toolbar and map selections to the existing composer card.
Do not enable Live Select until an actual adapter advertises and acknowledges it.

## Cursor work package: attachment transport

Add a project-scoped upload/read/delete API and persistent attachment IDs.
Proposed surface (not existing endpoints):

- `POST /api/v1/attachments` → id, filename, MIME type, byte size, dimensions,
  project identity and a same-origin read URL.
- `GET /api/v1/attachments/:id/content` → the original image.
- `DELETE /api/v1/attachments/:id` → remove an unreferenced draft attachment.

Validate actual image type, dimensions and size; keep the current UI limit of
6 images / 12 MB per image unless a capability declares otherwise. Do not
accept arbitrary filesystem paths or load caller-supplied remote URLs. Enforce
project access on every read and write. Keep images out of logs and provider-
specific configuration.

Extend feedback and handoff schemas with attachment IDs, message ownership,
retention and deletion semantics. Keep referenced message/handoff images after
removal from the composer. The UI will upload Blobs, replace draft IDs with
server IDs and show upload/error/retry states. An agent receives the actual
image only when its adapter supports images; never silently send a filename as
if an image had been transmitted. Model/reasoning options follow capabilities.

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
6. With a real agent adapter, perform one reversible visual edit, inspect file
   activity/diff, verify the target behavior and preview, then accept explicitly.
7. Exercise missing adapter, disconnected app, stale selection, rejected upload,
   failed request, retry, fast route changes, keyboard access and narrow screens.

UI regression test already available:
`HARNESS_BROWSER_CHANNEL=chrome node --test tests/cockpit-preview.test.mjs`
Omit HARNESS_BROWSER_CHANNEL where the installed Playwright Chromium is used.
Do not claim the inspector/upload/agent steps passed until their real integrations exist.

## UI update: rectangle groups

Example Select now supports drag rectangles and Shift-additive groups. The
composer retains every member ID, route and source identity; adaptation uses
an elements array. Group comments currently retain members under
`identity.appState.selectedElements` alongside the primary element identity.
The live inspector contract must support equivalent multi-selection payloads
rather than reducing a dragged group to a single element.
