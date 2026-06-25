# Tiptap Mobile Bridge

Run a [Tiptap](https://tiptap.dev) editor inside a webview and drive it from a native app
(Flutter / iOS / Android) over a small JSON message protocol. The editor renders in the
webview — so every Tiptap extension works as-is — while the native side sends commands and
receives events across the bridge.

A proof-of-concept with a reference Flutter host.

## Layout

- **`web/`** — the Tiptap editor + JS bridge, built to a single inlined HTML file.
- **`flutter_example/`** — a reference native host (native toolbar + webview) using the bridge.

## Docs

- **[PROTOCOL.md](./PROTOCOL.md)** — the JSON wire contract: commands, events, errors, lifecycle.
- **[GUIDE.md](./GUIDE.md)** — architecture, setup, per-platform transport, custom extensions.

## Quick start

```bash
cd web && npm install && npm run build    # builds + copies the bundle into flutter_example
cd ../flutter_example && flutter run       # iOS simulator or device
```

Only the Flutter host is implemented; iOS / Android wiring is documented in the guide.
