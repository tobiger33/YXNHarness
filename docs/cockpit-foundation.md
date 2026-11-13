# Cockpit foundation (local data)

The future website is a cockpit: it organizes projects, runs, feedback, and host
policy. This slice adds the **local data surface** only — no hosted service and
no UI.

## Host config (`harness.host.json`)

Host-owned policy for a project. Create it after the host reviews defaults:

```sh
npm run harness -- host-config --init --dry-run
npm run harness -- host-config --init --apply
npm run harness -- host-config --json
```

Defaults:

- **visibility:** `private`
- **shareLinkGrant:** `view` (never write or merge)
- **mergeAuthority:** `host`
- **browserInstallPolicy:** `ask-every-time` (agents still ask before `--yes`)
- **requireReviewedExpects:** `true`
- **allowForceOverwrite:** `false`

The schema lives in [`schema/host-config.schema.json`](../schema/host-config.schema.json).
Changing these values does not open ports or grant remote access by itself.

## Run index (`artifacts/index.json`)

Every scenario run refreshes a machine-readable index of local evidence:

```sh
npm run harness -- status
npm run harness -- status --json
```

`status` rebuilds `artifacts/index.json` from run directories plus
`last-run.json` / `last-green.json` / probe artifacts. The cockpit can later
read this file (or an equivalent API) to show recent runs, contact sheets, and
pass/fail without scraping the filesystem ad hoc.

## Handoff packages

Bundle one run for a trusted coding agent:

```sh
npm run harness -- handoff --from last-green --dry-run
npm run harness -- handoff --from last-green --apply
```

See [`handoff.md`](handoff.md).

## Read API for UI

```sh
npm run harness -- serve
```

Loopback-only UI + JSON for cockpit development (`/` shell, `/api/v1` data).
See [`cockpit-api.md`](cockpit-api.md).

## What this is not

- Not collaboration hosting
- Not share-link enforcement (policy data only for now)
- Not the designer UI — that comes later on top of this data
