# Cockpit layout

The local cockpit follows the accepted workbench design:

| Pane | Role |
|------|------|
| Left | Workspace nav, branches, recent activity |
| Center | Preview · Compare · Changes |
| Right | Agent chat / feedback, Connected/External, composer |

## Layout controls

- Drag the vertical splitters to resize either sidebar (8px hit track, full height)
- Double-click a splitter to reset (175px left / 315px right)
- Arrow keys (±10px, Shift ±30px), Home/End, Enter to collapse
- Top-bar panel buttons always reopen a collapsed pane
- Widths and collapse state persist in `localStorage` (`yxnharness.cockpit.layout.v1`)

## Real vs example

| Surface | Behavior |
|---------|----------|
| Branches / Runs / Feedback / Handoffs | Live API data |
| Changes + Übernehmen | Real `workspace/review` + `workspace/adopt` |
| Preview | Interactive example or an embedded running application |
| Compare demos | Layout examples only |
| Connected agent | Honest: no adapter unless one is connected |
| External mode | Builds a copyable task (no fake model replies) |

Light/Dark follow `color-scheme` / `light-dark()` system preference.

## Loading feedback

The YXN symbol animates in the brand during workspace requests. Region-level
feedback appears after 200ms, using the existing neutral surfaces without a
global overlay. The Preview example stays visible; its indicator reports the
actual workspace refresh, not a simulated app startup. A real preview lifecycle
can use the same region feedback once a preview adapter is connected.

Changes keeps the previous diff visible while fetching the selected review and
its patches. Merge actions stay hidden until the complete review is ready.
Outdated responses cannot overwrite a newer selection. Both regions offer an
inline Retry action after a failed request; read requests time out after 30s.
The loader SVG respects reduced-motion preferences.

## Image attachments

Screenshot opens a local image picker; images can also be pasted into the
composer. Capture uses the browser's native screen/tab chooser and stops the
stream after capturing a still frame. PNG, JPEG, WebP and GIF images are
supported (up to 6 images, 12 MB per image).

Thumbnails open a keyboard-accessible image dialog. Escape, Close or a click
outside dismisses it and restores focus. Draft text and context remain intact.
Images added to a message can also be reopened from that message. Draft images
persist as Blobs in IndexedDB; removing them or starting a new chat clears the
corresponding draft storage. They are not placed in localStorage.

This is local UI storage, not an agent upload API. External task text lists the
image names with an instruction to attach them separately. A backend adapter
must persist attachment IDs with feedback/messages and include the actual image
files in agent handoffs before images can reach a connected agent.

## Repository home

The root URL and `#/home` show the repository overview. The brand is a real link
to this page; `#/workspace` opens the existing three-pane workbench. Browser
Back/Forward and direct links work. Switching within the page keeps the composer,
attachments and panel layout mounted rather than rebuilding the workspace.

The connected repository is populated from the real workspace API. Search and
Recent filter the overview locally. Add workspace stores the name and address
of another running YXNHarness instance; opening that entry navigates to its
workbench. Entries persist in this browser's localStorage and can be removed.
Saved addresses are not presented as verified connections. Credential-bearing
URLs, query parameters and non-HTTPS/non-loopback addresses are rejected.

The backend still serves one root per instance. A cross-repository catalog,
GitHub repository discovery, clone/open actions and shared repository storage
require a backend contract; the UI does not pretend to provide those features.

## Preview interaction

Interact is the default. Normal app actions never add agent context. In the
built-in example, Continue → details form → Submit → completion is a real local
UI flow, including required-field validation and Back/Edit navigation. Select
must be explicitly enabled; Escape returns to Interact. Explicit selections
include the example screen route in their context.

Open app embeds a running HTTPS or loopback development server in an iframe.
Its navigation, links and form submissions run natively; the harness does not
rewrite target DOM, intercept its events or scrape UI state. The iframe remains
mounted when changing workbench tabs or visiting Home. Its address is restored
on reload. Reload and Open in new tab remain available. The application must
permit embedding; browser CSP/X-Frame-Options restrictions are not bypassed.

Live element selection is disabled until an opt-in inspector adapter exists.
The displayed URL is the initial preview address, not an inferred internal
router location. A target adapter must explicitly provide route and element
identity for accurate cross-origin element feedback. Screenshot attachment and
normal navigation remain available independently.

The Home rail shares the workbench's expanded sidebar width, gutter and label
spacing. Hidden workspaces retain their geometry. Home and Workbench fill the
window; long content scrolls inside the panes.

The built-in example registers selectable headers, text, progress, choice cards,
form fields and buttons across all of its screens with app-owned stable IDs.
Select highlights the hovered/chosen element; nested clicks choose the closest
registered element. Enter/Space also select focused example elements. Interact
restores normal controls and navigation. This does not implement an inspector
for arbitrary embedded third-party apps; those still require their opt-in adapter.

In example Select mode, dragging a rectangle selects all fully enclosed,
registered visible elements. It works in either direction. Clicks and rectangles
add to the existing selection by default; clicking a selected element again
removes only that member. Clear removes the full selection. Selection accumulates
across example screens, preserving each member's original route and revision. Pointer cancellation
or Escape cancels the gesture without activating app controls. Group identity,
route and revision persist in the composer. Adaptation requests pass the complete
elements array; grouped comments preserve all members in feedback appState.
The rectangle is a thin, non-interactive outline with a very light fill; actions
and metadata stay above the preview and in the composer. The composer uses a
neutral outer focus treatment instead of a blue outline around its textarea.

Selection hit testing excludes structural screen/form/fieldset wrappers. For
nested enclosed targets, the smallest concrete control or content wins. Text
selection tests the painted text bounds, so a narrow rectangle around visible
text does not require enclosing its full-width block. Blank clicks or empty
rectangles never fall back to the screen container. Movement is checked again
on pointer release to distinguish quick drags from clicks. A 350ms stationary
press commits the precise target once; release does not toggle it off. Hover
highlighting settles after 100ms without automatically adding context. A reserved
action slot keeps the canvas stationary while a hold selection is committed.

## Reviewing element comments

Each selected element/reference above the composer opens a native dialog with
its original route/revision, a visual snapshot (when captured) and its own
editable desired change. The snapshot is a restricted structured component tree,
not executable HTML; field values are not captured. Comments and their last ten
local revisions persist with the selection. Switching elements with unsaved
changes asks the user to save/cancel rather than discarding the text. Sending
includes the latest individual comments alongside common instructions.

Draft edits update the draft. Existing feedback can be reopened from chat or the
Feedback list. Saving it uses PATCH to append a new message/revision to the same
thread; prior messages remain visible. This neither rewrites already executed
agent work nor reruns an agent. Sent external references can be reviewed locally;
revisions must be sent again to update the external task. Visual snapshots are
cached locally for the most recent 50 element/revision identities. Missing
snapshots are labelled explicitly rather than fabricated.

Selection gestures must start and end inside the visible project preview.
Targets are validated as project-owned registered elements; shell controls,
sidebar, chat and outer canvas margins cannot become selection/comment targets.
