# Swift control surface (shape only)

This folder shows how a **Swift / SwiftUI / AppKit** app can implement the
same semantic harness contract used on the web. It is **not** a runnable macOS
app in CI and there is **no** shipped `macos-swift` runner yet.

## Status

| Piece | Status |
|-------|--------|
| Semantic contract (`HarnessControlling`) | Defined here |
| Opt-in flag | `yxnHarnessEnabled` |
| Browser/`attach` runner for Swift UI | **planned** |

When a web surface exists (e.g. shared JS), prefer
`npm run harness -- attach` with the web-browser runner today.

## Files

- `HarnessControlling.swift` — protocol + JSON-friendly result types
- `ExampleStore.swift` — tiny product store the adapter wraps
- `ExampleHarnessBridge.swift` — thin bridge (product actions only)

## Agent notes

1. Copy the protocol into the host app (or depend on an equivalent module).
2. Wrap real store/actions — do not scrape SwiftUI view trees.
3. Gate exposure with an explicit opt-in flag.
4. Wait for the `macos-swift` / `ios-swift` runner before claiming green
   visual runs on native windows/devices.

See [`docs/platforms.md`](../../docs/platforms.md).
