# Inspecting and setting up a project

The host (the person who starts or owns the project) decides what gets configured.
Their trusted coding agent executes the steps after explaining them — including
attaching to repos that never started as harness projects (see
[`attach-existing.md`](attach-existing.md)). Nothing should be opaque: every
command either explains itself or asks before changing the machine.

## 1. Inspect (read-only)

```sh
npm run harness -- doctor --root /path/to/project
npm run harness -- doctor --root /path/to/project --json
```

The doctor reads common project manifests, package scripts, likely entrypoints,
Git status, and a bounded set of source files for explicit `__harness` markers.
It does not start the app, install dependencies, or modify files. Source matches
are clues, not proof that the full control contract is implemented. The report
includes plain-language `nextSteps` so a host or agent can see what comes next
and why.

## 2. Write config (preview, then apply)

```sh
npm run harness -- setup --root /path/to/project --dry-run
npm run harness -- setup --root /path/to/project --apply
```

Setup defaults to preview mode when you omit flags. `--apply` creates only a
missing `harness.config.json`, using a detected package-manager start script and
a best-effort local development URL. Review both before running a scenario:
scripts may use custom ports or behavior that cannot be inferred statically.
An existing config is never overwritten. Setup does not modify app source or
guess app-specific commands. The runner's `navigationTimeoutMs` and
`commandTimeoutMs` can be set under `app` in `harness.config.json`; otherwise it
uses safe defaults.

## 3. Install the local browser (with consent)

Chromium is required for probes and screenshots. The harness can install it, but
only after explicit consent via `--yes`. The trusted agent should ask the host
first, then re-run with `--yes` if they agree.

```sh
npm run harness -- setup --install-browser
npm run harness -- setup --install-browser --yes
```

You can combine config apply and browser install:

```sh
npm run harness -- setup --root /path/to/project --apply --install-browser --yes
```

`run` never installs Chromium on its own. If the browser is missing, it tells
you to ask the host and use the commands above.

## 4. Probe the live control surface

After config exists and the app exposes `window.__harness`:

```sh
npm run harness -- probe --root /path/to/project --json
```

Probe starts the configured app, opens it with `?harness=1`, and prints live
`commands()`, `state()`, and clock time. If Chromium is missing, probe asks for
the same consent path (`--yes`) instead of installing silently.

## 5. Scaffold a draft scenario

Turn the live command list into a reviewable YAML draft:

```sh
npm run harness -- scaffold --root /path/to/project --dry-run
npm run harness -- scaffold --root /path/to/project --apply
```

Scaffold probes the app, fills example payloads from each command's
`payloadSchema`, and writes `scenarios/smoke.yaml` by default (`--name` /
`--out` to choose). It never invents authoritative `expect` blocks — the host
or trusted agent must review payloads and add expectations before trusting a
green run. Existing files are preserved unless `--force` is passed after host
consent.

## 6. Wire the control surface (native, in the target app)

If the doctor cannot find a harness control surface, implement it in the target
app using its native actions and state (web: `window.__harness`; Swift:
`HarnessControlling`). Do not infer state by parsing rendered UI trees. Read
[platforms](platforms.md) and [the control convention](control-convention.md),
then probe again (when a ready runner matches), add a scenario, and run it.
Native/mobile launchers are reported as planned runners and are not attachable
until their adapter ships.
