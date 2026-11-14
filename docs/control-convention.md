# Control convention

`window.__harness` is the **web binding** of the language-neutral harness
control surface. It lets a runner or coding agent observe and operate an app
without reverse-engineering its DOM.

The same semantic contract (state / commands / command / events / clock) applies
to Swift, Kotlin, Dart, and other languages — see [`platforms.md`](platforms.md).
Only the web binding is runnable with the shipped browser runner today.

## Opt-in

The app creates the interface only when the URL has `?harness=1` or the app
sets `window.__HARNESS_ENABLED__ = true` before its application bootstrap.
Without that flag there must be no `window.__harness` and no harness-driven
change to product behavior.

## Contract

```ts
interface HarnessAPI {
  readonly version: number;
  state(): JsonObject;
  commands(): Array<{
    name: string;
    description: string;
    payloadSchema?: JsonObject;
  }>;
  command(name: string, payload?: JsonValue): Promise<
    | { ok: true; value?: JsonValue }
    | { ok: false; error: { code: string; message: string; validCommands?: string[] } }
  >;
  on(event: "statechange" | "animationend" | "error", handler: (event: CustomEvent) => void): void;
  off(event: "statechange" | "animationend" | "error", handler: (event: CustomEvent) => void): void;
  clock: {
    pause(): void;
    resume(): void;
    advance(milliseconds: number): JsonObject;
    seek(milliseconds: number): JsonObject;
    now(): number;
  };
}
```

`state()` must return a fresh JSON-serializable snapshot. Apps should expose
meaningful semantic fields such as the active screen, form values, and
available actions. `commands()` is the source of truth for allowed actions and
their payload schemas. Unknown commands return a structured error containing
the valid names.

Clock values are milliseconds. `advance()` deterministically advances through
intermediate animation states; `seek()` sets an absolute clock time.
Framework-specific adapters may wrap this contract but must not be required by
the core.

## Runner behavior

The scenario runner checks `version`, calls `commands()` before any action,
validates declared payloads against the advertised JSON Schemas, and records
`state()` before and after each command. A mismatch or command error fails the
run. The runner does not treat page text or screenshots as instructions.

Scenario documents use version 1 of
[`schema/scenario.schema.json`](../schema/scenario.schema.json). The app
startup command is configured as an argument array (never shell text), and
local runs are restricted to loopback URLs. Only a small platform environment
allowlist is inherited by default; `app.inheritEnv` names additional variables
explicitly and should not include credentials when running untrusted project
code.

A scenario can advance or seek the virtual clock without calling an app
command:

```yaml
- name: render at 250ms
  clock:
    seek: 250
  expectClock: 250
  snapshot: frame-250ms
```

`advance` takes a non-negative delta; `seek` sets an absolute time, both in
milliseconds. Each step may assert `expectClock`. The runner pauses the clock
before the scenario, bounds app navigation and control calls with configurable
timeouts (`app.navigationTimeoutMs` and `app.commandTimeoutMs`), and stops the
app's process tree after the run. Navigation waits for document readiness and
the explicit control API rather than requiring the network to become idle.

## Target-project integration

When adding the control surface to an existing project, implement it using the
project's own actions, state stores, and animation clock. Do not use
`MutationObserver`-based UI rewriting, DOM text scraping, event suppression,
monkeypatches, or template string replacement. The interface should be
development-only and should not add production dependencies.
