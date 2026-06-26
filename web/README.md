# web

The Tiptap editor and the JSON bridge, built to a single self-contained HTML file that the native
hosts load from the device. This is the part you customize and ship; the native side is a thin
transport around it.

## Build

```bash
npm install
npm run build   # writes dist/index.html, then copies it into the example apps
```

`npm run dev` serves the same code with an in-browser host simulator (open the printed URL, then
add `/dev.html`) for testing without a native toolchain.

## Source

- `protocol.ts` the wire contract (types)
- `bridge.ts` transport plus platform auto-detection
- `main.ts` the editor (its extension set) plus command and event handling
- `editor.css` editor styling (includes responsive images)
- `dev-host.ts` the in-browser host simulator (dev only)

To put this in your own app, see
[Use the bridge in your own app](../GUIDE.md#use-the-bridge-in-your-own-app).
