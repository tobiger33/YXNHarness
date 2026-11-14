# Cockpit API (local)

A loopback-only HTTP server: a small static cockpit shell plus a JSON API so UI
work can consume host policy, runs, handoffs, artifacts, and branch review —
without scraping the filesystem.

## Start

```sh
npm run harness -- serve
npm run harness -- serve --port 8787
npm run harness -- serve --root /path/to/project --json
```

Binds **127.0.0.1 only**. Stop with Ctrl+C.

Open `http://127.0.0.1:8787/` for the cockpit shell (files from `cockpit/` in
this package). JSON stays under `/api/v1/…`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Cockpit UI (`cockpit/index.html`) |
| GET | `/cockpit/*` | Static shell assets (CSS/JS) |
| GET | `/api` · `/api/v1` | API index (JSON) |
| GET | `/api/v1/health` | Liveness |
| GET | `/api/v1/overview` | Host + run summary + recent handoffs |
| GET | `/api/v1/host-config` | `harness.host.json` (or missing) |
| GET | `/api/v1/workspace` | Current branch/revision + local branches |
| GET | `/api/v1/workspace/review` | `?ref=<branch>&path=<file>` — PR-style diff |
| POST | `/api/v1/workspace/adopt` | `{ "ref", "apply"?, "force"?, "comment"? }` — merge theirs → yours |
| GET | `/api/v1/runs` | Run index (`?refresh=0` to skip rebuild) |
| GET | `/api/v1/runs/:runId` | One run + `result.json` |
| GET | `/api/v1/handoffs` | Handoff list + last pointer |
| GET | `/api/v1/handoffs/:handoffId` | One handoff manifest |
| GET | `/api/v1/artifacts/...` | Safe file read under `artifacts/` only |

## Review & Übernehmen

The shell lists other local branches in the left rail. Selecting one opens a
clean file list + unified diff (Cursor / VS Code / GitHub style). **Übernehmen**
opens a slim confirm sheet (diff stays visible) with an optional note — then
POSTs to `/api/v1/workspace/adopt` (`apply: true`, optional `comment`).

The note is recorded on the merge commit when provided. Empty note = take as-is.

That is the only write route. Create/checkout remain CLI-only until a broader
authenticated control plane exists.

See also [`workspace.md`](workspace.md), [`cockpit-foundation.md`](cockpit-foundation.md),
and [`handoff.md`](handoff.md).
