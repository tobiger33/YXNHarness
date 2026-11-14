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
| POST | `/api/v1/workspace/adopt` | `{ "ref", "apply"?, "force"?, "comment"?, "paths"\|"path"?, "hunks"? }` — branch merge or file/hunk adopt |
| GET | `/api/v1/runs` | Run index (`?refresh=0` to skip rebuild) |
| GET | `/api/v1/runs/:runId` | One run + `result.json` |
| GET | `/api/v1/compare` | `?baseline=&against=` — state + screenshot diff |
| GET | `/api/v1/promote` | `?from=` — preview expect promotion (no write) |
| GET | `/api/v1/feedback` | Feedback thread list |
| GET | `/api/v1/feedback/:id` | Feedback thread detail |
| POST | `/api/v1/feedback` | Create feedback thread |
| PATCH | `/api/v1/feedback/:id` | Edit / resolve feedback |
| POST | `/api/v1/feedback/bundle` | Bundle threads into a handoff |
| POST | `/api/v1/elements/adopt` | `{ elements, apply?, withHandoff?, sourceBranch?, body? }` — visual element adopt |
| GET | `/api/v1/agent` | Agent panel state (honest: not connected) |
| GET | `/api/v1/handoffs` | Handoff list + last pointer |
| GET | `/api/v1/handoffs/:handoffId` | One handoff manifest |
| GET | `/api/v1/artifacts/...` | Safe file read under `artifacts/` only |

## Workbench layout

The shell follows the accepted workbench layout (Preview / Compare / Changes):

- Left workspace: nav, branches, recent activity (resizable / collapsible)
- Center stage: Preview, Compare, Changes tabs
- Right Agent: Connected/External, chat/feedback, model + reasoning, composer
- Panel widths persist in `localStorage`; double-click a splitter to reset

**Changes** loads a real 3-dot branch review; **Übernehmen** POSTs
`/api/v1/workspace/adopt`. Composer messages become local feedback when no
agent adapter is connected. Preview/Compare demos are layout examples only.

See also [`feedback.md`](feedback.md), [`workspace.md`](workspace.md),
[`cockpit-foundation.md`](cockpit-foundation.md), and [`handoff.md`](handoff.md).
