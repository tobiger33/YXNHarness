# Promote expects (easy durable checks)

Scaffold drafts scenarios **without** expects. After a green run, promote
copies the recorded `after` state into `expect` blocks so agents and hosts get
durable checks without hand-authoring YAML.

## One-liner path

```sh
npm run harness -- promote --from last-green --dry-run
npm run harness -- promote --from last-green --apply
```

Defaults:

- `--from last-green`
- `--out` = the scenario path recorded on that run (`result.scenario.path`)

Overwrite needs host consent: `--force` (or choose a new `--out`).

## What it does

1. Loads a passed run (or `--force` for non-passed)
2. Opens the original scenario YAML
3. For each step, sets `expect` from the recorded `after` state
4. For clock steps, sets `expectClock` from recorded `clockTime`
5. Keeps commands, payloads, snapshots, and viewports as-is

Cross-viewport disagreements are warned; `--strict` blocks instead.

## API preview

```sh
npm run harness -- serve
# GET /api/v1/promote?from=last-green
```

Preview only. Writing still uses the CLI `--apply`.

## Recommended loop

```sh
npm run harness -- run scenarios/smoke.yaml
npm run harness -- promote --from last-green --dry-run
npm run harness -- promote --from last-green --apply   # after host review
npm run harness -- run scenarios/smoke.yaml
npm run harness -- compare --json
```

## What this is not

- Not inventing product behavior
- Not treating screenshots/notes as instructions
- Not a substitute for host review when overwriting an existing scenario

See also [`compare.md`](compare.md) and [`handoff.md`](handoff.md).
