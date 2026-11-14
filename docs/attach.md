# Attach (one-command loop)

`harness attach` chains the existing honest APIs into one agent-friendly path:

**doctor → setup → browser → probe → scaffold → run → promote**

No fake agents. Each phase uses the same modules as the standalone commands.
Dry-run stays honest: it does not write config/scenarios or install Chromium.
Live probe/run still need a ready browser and (for probe+) a working app.

## Defaults

| Mode | Default `--until` | Writes? |
|------|-------------------|---------|
| (neither flag) / `--dry-run` | `probe` | No |
| `--apply` | `scaffold` | Yes (config + scenario draft) |

Stop earlier or later with `--until doctor|setup|browser|probe|scaffold|run|promote`.

## Quick start

```sh
# Preview through probe (no writes)
npm run harness -- attach --dry-run

# After host review: write config + draft scenario (Chromium needs --yes)
npm run harness -- attach --until scaffold --apply --yes

# Full loop after a green path exists
npm run harness -- attach --until promote --apply --yes
```

JSON for agents:

```sh
npm run harness -- attach --dry-run --json
```

## Flags

| Flag | Role |
|------|------|
| `--until <phase>` | Stop after this phase |
| `--name` / `--out` | Scaffold scenario name / path |
| `--scenario` | Scenario path for scaffold/run (alias of out when scaffolding) |
| `--from` | Promote source (`last-green` default) |
| `--install-browser` | Plan/perform Chromium install (still needs `--yes` to install) |
| `--yes` | Host consent for Chromium install / live probe browser ensure |
| `--force` | Overwrite existing scaffold scenario |
| `--strict` | Promote treats cross-viewport disagreements as blocked |
| `--skip-doctor` | Skip the doctor phase (still runs later phases) |
| `--dry-run` / `--apply` | Preview vs write |

## Blocking behavior

- **setup blocked** — fix start command/URL, then re-run with `--until setup --apply`
- **browser consent** — ask the host, then `--apply --install-browser --yes`
- **probe fails (no `__harness`)** — implement the control surface natively; see [`attach-existing.md`](attach-existing.md)
- **scaffold blocked** — choose `--out` or pass `--force` after host consent
- **run not passed** — fix expects/commands; promote only runs after a passed run
- **dry-run + `--until run|promote`** — stops after scaffold; re-run with `--apply`

## Relation to other docs

- Agent playbook for foreign repos: [`attach-existing.md`](attach-existing.md)
- Control contract: [`control-convention.md`](control-convention.md)
- Standalone steps: [`project-setup.md`](project-setup.md), [`promote.md`](promote.md)

## What this is not

- Not a hosted service or MCP requirement
- Not DOM scraping / MutationObserver attach
- Not silent Chromium install or silent `--force` overwrites
