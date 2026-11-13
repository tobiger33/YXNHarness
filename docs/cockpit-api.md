# Cockpit read API (local)

A loopback-only, read-only HTTP API so cockpit UI work can consume host policy,
runs, handoffs, and artifact files without scraping the filesystem.

## Start

```sh
npm run harness -- serve
npm run harness -- serve --port 8787
npm run harness -- serve --root /path/to/project --json
```

Binds **127.0.0.1 only**. No write routes. Stop with Ctrl+C.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/health` | Liveness |
| GET | `/api/v1/overview` | Host + run summary + recent handoffs |
| GET | `/api/v1/host-config` | `harness.host.json` (or missing) |
| GET | `/api/v1/runs` | Run index (`?refresh=0` to skip rebuild) |
| GET | `/api/v1/runs/:runId` | One run + `result.json` |
| GET | `/api/v1/handoffs` | Handoff list + last pointer |
| GET | `/api/v1/handoffs/:handoffId` | One handoff manifest |
| GET | `/api/v1/artifacts/...` | Safe file read under `artifacts/` only |

## For UI work

Point the cockpit frontend at `http://127.0.0.1:8787` during local design.
Treat responses as data. Do not invent write APIs here — host actions stay on
the CLI (`setup`, `handoff`, etc.) until an explicit authenticated control plane
exists.

See also [`cockpit-foundation.md`](cockpit-foundation.md) and
[`handoff.md`](handoff.md).
