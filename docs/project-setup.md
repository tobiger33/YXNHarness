# Inspecting and setting up a project

Run the doctor against the target project before changing it:

```sh
npm run harness -- doctor --root /path/to/project
npm run harness -- doctor --root /path/to/project --json
```

The doctor reads common project manifests, package scripts, likely entrypoints,
Git status, and a bounded set of source files for explicit `__harness` markers.
It does not start the app, install dependencies, or modify files. Source matches
are clues, not proof that the full control contract is implemented.

Preview setup before applying it:

```sh
npm run harness -- setup --root /path/to/project --dry-run
npm run harness -- setup --root /path/to/project --apply
```

Setup defaults to preview mode. `--apply` creates only a missing
`harness.config.json`, using a detected package-manager start script and a
best-effort local development URL. Review both before running a scenario:
scripts may use custom ports or behavior that cannot be inferred statically.
An existing config is never overwritten. Setup does not install packages,
launch processes, create source integrations, or guess app-specific commands.
The runner's `navigationTimeoutMs` and `commandTimeoutMs` can be set under
`app` in `harness.config.json`; otherwise it uses safe defaults.

If the doctor cannot find `window.__harness`, implement the control surface in
the target app using its native actions and state. Do not infer state by parsing
the rendered DOM. Read [the control convention](control-convention.md), then
add and run a scenario that exercises the actual flow. Native/mobile launchers
are reported but are not yet supported by the browser runner.
