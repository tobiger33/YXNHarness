# Platforms and languages

YXNHarness is **language-neutral**. The product language may be JavaScript,
Swift, Kotlin, Dart, C#, or anything else that can expose a small control
surface. What matters is the **semantic contract**, not the runtime.

The shipped runner today is **web-browser** only. Other runners are declared
as `planned` so doctor/attach stay honest.

## Semantic control contract

Every platform binding must provide the same JSON-shaped capabilities:

| Capability | Meaning |
|------------|---------|
| `version` | Contract version (currently `1`) |
| `state()` | Fresh JSON object snapshot of product state |
| `commands()` | Discoverable actions + optional JSON Schema payloads |
| `command(name, payload?)` | Run one declared action; structured ok/error |
| events | `statechange`, `animationend`, `error` |
| `clock` | `pause` / `resume` / `advance` / `seek` / `now` (ms) |

Bindings:

| Runtime | Binding | Runner status |
|---------|---------|---------------|
| Web (any SPA that can run in Chromium) | `window.__harness` | **ready** |
| Swift (macOS / iOS) | `HarnessControlling` + local JSON bridge | planned |
| Kotlin / Android | `HarnessControlling` interface + JSON bridge | planned |
| Flutter / Dart | Dart harness API + JSON bridge | planned |
| Electron | reuse web binding in renderer | planned (launch) |
| .NET UI | `IHarnessControlling` + JSON bridge | planned |

Web details: [`control-convention.md`](control-convention.md).  
Swift shape: [`examples/swift-control-surface`](../examples/swift-control-surface).

## Hard rules (all languages)

- Implement control through the app's own actions/stores/hooks — never by
  scraping rendered trees or rewriting UI with observers.
- Opt in explicitly (web: `?harness=1` / `__HARNESS_ENABLED__`; Swift:
  `yxnHarnessEnabled`).
- Do not claim a planned runner is attachable.
- Prefer an existing web surface (Expo web, Flutter web, Electron renderer)
  when one exists — that path works with the shipped browser runner today.

## Doctor / attach

```sh
npm run harness -- doctor --root /path/to/project --json
```

Inspect `project.platform`, `project.platforms`, `project.languageMarkers`,
and `agentAttach.runners`. `agentAttach.attachable` is true only when a
**ready** runner matches and a start path exists.

Schema for runner declarations:
[`schema/runner-adapter.schema.json`](../schema/runner-adapter.schema.json).

## Adding a language

1. Implement the semantic contract in that language (see Swift example).
2. Keep doctor detection honest (`scripts/platforms.mjs`).
3. Ship a runner adapter only when start/probe/run evidence works end-to-end.
4. Until then: `status: "planned"` — agents implement the control surface, hosts
   wait for the runner.
