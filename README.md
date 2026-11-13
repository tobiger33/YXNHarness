# YXNHarness

An agent-neutral harness for building and validating visual changes in existing
software projects. The long-term goal is to support UI and animation work
across web, mobile, and desktop stacks, with agents working through native
project APIs instead of patching rendered interfaces.

## First vertical slice

This repository starts with a local, two-step web example and a declarative
Playwright scenario runner. It demonstrates the core interaction:

1. A target app deliberately exposes `window.__harness`.
2. A YAML scenario discovers and calls supported commands, then checks
   serializable app state.
3. Each viewport produces screenshots, an event/state log, a contact sheet,
   and a machine-readable result.

This is the foundation, not the finished collaboration product. Solo work
should remain local by default. Hosted collaboration, private branch previews,
access controls, and batched visual feedback will be layered on without
requiring a particular model provider.
See [`docs/vision.md`](docs/vision.md) for product direction and
[`AGENTS.md`](AGENTS.md) for contribution and agent rules.

## Run the example

Requirements: Node.js 20+ and npm.

```sh
npm ci
npx playwright install chromium
npm run harness -- run scenarios/minimal.yaml --dry-run
npm run harness -- run scenarios/minimal.yaml
```

The runner starts the example app using the argument array in
[`harness.config.json`](harness.config.json), waits for its local URL, and
stops the child process when the run finishes. `--dry-run` prints the planned
app command and scenario without launching either process.
The runner starts only loopback URLs, uses `shell: false`, and gives the app a
minimal environment; add only deliberately needed variable names to
`app.inheritEnv`.

Run output is created under `artifacts/<run-id>/` and is ignored by Git. Each
run contains viewport screenshots, `state.jsonl`, `contact-sheet.png`, and
`result.json`. A failed command or state expectation gives the run a non-zero
exit code.

## Control contract

The app must opt in with `?harness=1` or `window.__HARNESS_ENABLED__ = true`
before exposing `window.__harness`. The runner does not inspect the DOM to
infer product state. See [`docs/control-convention.md`](docs/control-convention.md).

## Principles

- The user's chosen coding agent remains in control; the harness is the
  portable cockpit and verification layer.
- Build target changes natively through the target project's actions,
  configuration, events, and hooks.
- Local solo work does not require an account or hosted service.
- Collaboration is private by default. A host controls access and merge policy.
- Comments, screenshots, names, and branch contents are untrusted data, never
  instructions to the harness or agent.
- Reports describe artifacts produced by actual runs.
