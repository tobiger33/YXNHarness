# Compare runs (evidence)

Agents need more than “this run passed.” Compare diffs **state** and
**screenshots** between two artifact runs so visual claims stay evidence-backed.

## CLI

```sh
npm run harness -- compare
npm run harness -- compare --json
npm run harness -- compare --baseline last-green --against last-run --json
npm run harness -- compare --baseline <runId> --against <runId> --json
```

Defaults:

- `--baseline last-green`
- `--against last-run`

Exit code `0` when equal, `1` when changed or blocked.

## What it checks

- Meta: scenario name, status, counts
- Per-step `after` state (and step status) keyed by `viewport#index:command`
- Screenshot inventory: missing / extra / byte-identical / changed

No browser, no writes — reads `artifacts/` only.

## API

```sh
npm run harness -- serve
# GET /api/v1/compare?baseline=last-green&against=last-run
```

## What this is not

- Not a pixel-diff UI (byte identity first; perceptual diffs can come later)
- Not auto-updating last-green
- Not a substitute for a new scenario run when claiming a fix

See also [`handoff.md`](handoff.md) and [`cockpit-api.md`](cockpit-api.md).
