# Attach to an existing repo (agent playbook)

**Audience: coding agents.** The host points you at any existing GitHub/local
project. You attach YXNHarness; the project does not need a harness-shaped
layout.

## Goal

Make visual runs possible on a repo that was never started for YXNHarness:

1. Discover how the app starts and which URL it serves.
2. Write only `harness.config.json` (preview → apply).
3. If missing, implement a **thin native** `window.__harness` adapter.
4. Probe → scaffold scenario → run → handoff evidence.

## Hard rules

- Use the app's own actions/state/stores/hooks.
- Never scrape the DOM or rewrite UI with `MutationObserver`.
- Never install Chromium without host `--yes` consent.
- Never overwrite existing `harness.config.json` / scenarios without host
  consent (`--force`).

## Procedure

Prefer the one-command loop ([`attach.md`](attach.md)):

```sh
npm run harness -- attach --root /path/to/existing-app --dry-run --json
# Show the host the plan. Fix start URL if needed, then:
npm run harness -- attach --root /path/to/existing-app --until scaffold --apply --yes
```

Or step through the same APIs:

```sh
# From the YXNHarness checkout (or a path that can run the harness CLI):
npm run harness -- doctor --root /path/to/existing-app --json
```

Read `nextSteps`, `warnings`, and `agentAttach` in the JSON. Then:

```sh
npm run harness -- setup --root /path/to/existing-app --dry-run
# Show the host the planned start command + URL. Fix port if wrong.
npm run harness -- setup --root /path/to/existing-app --apply
```

If `agentAttach.controlSurfaceRequired` is true, **you** implement the adapter
in the target repo (product language). Pattern reference:

- Contract: [`control-convention.md`](control-convention.md)
- Example adapter: [`examples/foreign-booking/harness-adapter.js`](../examples/foreign-booking/harness-adapter.js)

Then:

```sh
npm run harness -- probe --root /path/to/existing-app --json
npm run harness -- scaffold --root /path/to/existing-app --dry-run
npm run harness -- scaffold --root /path/to/existing-app --apply
# Review expects with the host, then:
npm run harness -- run scenarios/smoke.yaml --root /path/to/existing-app
npm run harness -- handoff --root /path/to/existing-app --from last-green --apply
```

## What “no prescribed structure” means

- No required monorepo package name, folder, or framework.
- Config is one JSON file naming `app.start` + loopback `app.url`.
- Scenarios/artifacts appear after you create them; they are evidence, not the
  product source of truth.
- Branches remain the project's Git branches (`harness workspace …`).

## Fixture

[`examples/foreign-booking`](../examples/foreign-booking) is a stand-in
“already existed” app: product store first, optional adapter second. Use it to
practice the attach loop before touching a host production repo.

## Not yet agent-automated

Electron / native Mac (Swift) / iOS / Android / Expo-device launchers are
**planned** runners — see [`platforms.md`](platforms.md). Prefer the web
surface when one exists (e.g. Expo web, Flutter web). Implement the semantic
control contract in the app language now (Swift shape:
[`examples/swift-control-surface`](../examples/swift-control-surface)); do not
claim browser attach for a native-only surface. Ask the host which surface to
target when unclear.
