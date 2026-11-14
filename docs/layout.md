# Cockpit layout

The local cockpit follows the accepted workbench design:

| Pane | Role |
|------|------|
| Left | Workspace nav, branches, recent activity |
| Center | Preview · Compare · Changes |
| Right | Agent chat / feedback, Connected/External, composer |

## Layout controls

- Drag the vertical splitters to resize either sidebar
- Double-click a splitter to reset (175px left / 315px right)
- Arrow keys (±10px, Shift ±30px), Home/End, Enter to collapse
- Top-bar panel buttons always reopen a collapsed pane
- Widths and collapse state persist in `localStorage` (`yxnharness.cockpit.layout.v1`)

## Real vs example

| Surface | Behavior |
|---------|----------|
| Branches / Runs / Feedback / Handoffs | Live API data |
| Changes + Übernehmen | Real `workspace/review` + `workspace/adopt` |
| Preview / Compare demos | Layout examples only |
| Connected agent | Honest: no adapter unless one is connected |
| External mode | Builds a copyable task (no fake model replies) |

Light/Dark follow `color-scheme` / `light-dark()` system preference.
