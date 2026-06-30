# Flutter example (flutter_inappwebview)

A native Flutter host for the Tiptap Mobile Bridge: it loads the editor into a
[`flutter_inappwebview`](https://pub.dev/packages/flutter_inappwebview) webview and drives it over
the JSON protocol. It is the Flutter counterpart to [`ios_example/`](../ios_example), and the two
share the same web bundle and protocol.

## What it demonstrates

- Loads the built editor bundle from the app's assets (offline, no server).
- Outbound (editor to host) via a registered `tiptapBridge` JavaScript handler, so the web side
  detects the Flutter platform and routes messages here.
- Inbound (host to editor) via `evaluateJavascript("window.tiptapBridge.handleCommand(...)")`,
  passing the command JSON as a correctly escaped string literal.
- Command responses correlated to their request by `id`, using a `Completer` per command.
- On load: send `init`, then `subscribe` to `focus`, `blur`, and `update`; received events are
  logged with `debugPrint`.
- A native toolbar (bold, italic, underline, strike, highlight, headings, lists, align, link,
  table) whose buttons send `exec`
  commands and light up from `selectionChanged` state, plus Get JSON / Get HTML and a native image
  picker that inserts the chosen photo over the bridge.
- An `uploadImage` host request: pasting an image asks the host to upload it and inserts the
  returned URL (a placeholder here; see below).

## Requirements

- The Flutter SDK (run `flutter doctor`).
- An iOS simulator or device. The host is plain Flutter, so other targets work too; it is tested
  on iOS.

## Build and run

```bash
cd flutter_example
flutter pub get
flutter run        # choose an iOS simulator or device
```

Tap into the editor and type; use the toolbar to format the selection (the buttons send `exec` and
light up from `selectionChanged`), and Get JSON / Get HTML to fetch the content.

## Refresh the editor from the web build

The editor is authored once in [`web/`](../web). Rebuilding it runs a postbuild step that copies
the single inlined bundle into this app's assets (and the iOS app's):

```bash
cd web
npm install
npm run build   # writes web/dist/index.html, then copies it to
                # flutter_example/assets/editor.html
```

Do not hand edit `assets/editor.html`; it is generated from the web build.

## Layout

```
lib/
  main.dart            the app: native toolbar, webview, event logging, image picker
  tiptap_bridge.dart   the bridge: id-correlated commands, events, host requests
assets/editor.html     the built web bundle (generated, do not edit)
pubspec.yaml           declares the asset and deps (flutter_inappwebview, image_picker)
```

## Protocol

See [PROTOCOL.md](../PROTOCOL.md) for the wire contract (commands, events, host requests, errors)
and [GUIDE.md](../GUIDE.md#transport-per-platform) for the Flutter transport notes.
