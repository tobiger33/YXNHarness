# Project share invites

A share invite is a **local, view-or-comment package** that describes how
collaborators may look at a project. It does not open ports, host a site, or
grant write/merge rights. Merge authority stays with the host
([`vision.md`](vision.md), [`cockpit-foundation.md`](cockpit-foundation.md)).

## Create an invite

```sh
npm run harness -- share --dry-run
npm run harness -- share --apply --note "Review pricing hero"
npm run harness -- share --json
```

Writes under `artifacts/shares/<shareId>/`:

- `share.json` — machine-readable policy + git stamp + design-approval path
- `SHARE_README.md` — human rules
- `host-config.snapshot.json` when `harness.host.json` exists

Also updates `artifacts/last-share.json`.

Host policy (`harness.host.json`):

- `access.shareLinkGrant`: `view` | `comment` | `none` (none blocks invites)
- `access.mergeAuthority`: always `host`
- Share links never include write or merge

## Delivery: web link later, file now

| Now | Later |
|-----|--------|
| Local folder / Git remote | Hosted web link carrying the same JSON |
| Loopback cockpit (`harness serve`) | Private self-hosted cockpit URL |

The invite JSON is shaped so a future web link can reuse it without upgrading
grants.

## Design “yes” → visible to others

1. Host reviews the branch in Changes (or Preview).
2. Host clicks **Design passt** in the cockpit, or:

```sh
npm run harness -- workspace --approve <their-branch> --dry-run
npm run harness -- workspace --approve <their-branch> --apply
```

That whole-branch merges with note `Design approved` (override with `--note`).
It does **not** push.

3. Host pushes (plain `git push` — still outside the harness).
4. Collaborators refresh remotes on demand (cockpit button or):

```sh
npm run harness -- workspace --fetch --dry-run
npm run harness -- workspace --fetch --apply
```

Fetch updates **remote-tracking refs only**. It does not checkout, merge, or
background-poll. Run it after a known push (efficient), not on a timer.

See also [`workspace.md`](workspace.md).

## Cockpit API

```sh
npm run harness -- serve
```

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/v1/share` | List local share invites |
| POST | `/api/v1/share` | `{ apply?, force?, note? }` — create invite |
| POST | `/api/v1/workspace/fetch` | `{ apply?, remote?, prune? }` — refresh remotes |

## Efficiency

- Prefer on-demand fetch after push over continuous polling.
- Prefer static share JSON over uploading the whole repo for a view link.
- Prefer branches + commits as the source of truth.
- Keep solo work loopback-local until the host opts into hosting.

## What this is not

- Not a public CDN or automatic project upload
- Not silent write/merge via share link
- Not live-on-save multiplayer editing
- Not a replacement for Git remotes
