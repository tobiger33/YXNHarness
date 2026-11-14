# Foreign booking (attach demo)

Stand-in for an **already existing** web app that did not start as a harness
project. Product logic lives in `store.js` / `app.js`. The optional
`harness-adapter.js` maps that store onto `window.__harness` when
`?harness=1` is present. `preview-inspector.js` adds the live Select bridge
when the cockpit also injects `yxnSession` + `yxnParentOrigin` (see
[`docs/preview-inspector.md`](../../docs/preview-inspector.md)).

## Point YXNHarness at this folder

From the YXNHarness repo root:

```sh
npm run harness -- doctor --root examples/foreign-booking --json
npm run harness -- setup --root examples/foreign-booking --dry-run
npm run harness -- setup --root examples/foreign-booking --apply
# verify url/port in harness.config.json (default 4173)
npm run harness -- probe --root examples/foreign-booking --json
npm run harness -- scaffold --root examples/foreign-booking --dry-run
npm run harness -- run scenarios/smoke.yaml --root examples/foreign-booking
```

No special monorepo layout is required: only a start command, a loopback URL,
and a native control adapter.
