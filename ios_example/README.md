# iOS example (SwiftUI + WKWebView)

A native iOS host for the Tiptap Mobile Bridge: a SwiftUI app that loads the editor into a
`WKWebView` and drives it over the same JSON protocol as the Flutter example. It is the iOS
counterpart to [`flutter_example/`](../flutter_example), proving the protocol is platform
agnostic with runnable native code.

## What it demonstrates

- Loads the built editor bundle from the app bundle (offline, no server).
- Outbound (editor to host) via a `WKScriptMessageHandler` named `tiptapBridge`, so the web
  side detects the iOS platform and routes messages here.
- Inbound (host to editor) via `evaluateJavaScript("window.tiptapBridge.handleCommand(...)")`,
  passing the command JSON as a correctly escaped JS string literal.
- Command responses correlated to their request by `id`, using Swift `async`/`await`.
- On load: send `init`, then `subscribe` to `focus` and `blur`. Received events are logged to
  the console and the latest one is shown in the header.
- A native toolbar (Bold, Italic, H1, Bullet list) whose buttons send `exec` commands and
  light up from `selectionChanged` state, plus Get JSON and Get HTML (content fetch on demand).

## Requirements

- Xcode 16 or newer (the project uses a synchronized file group, `objectVersion` 77).
- An iOS 17 or newer simulator or device.

## Build and run

### Xcode

Open `TiptapBridgeExample.xcodeproj`, choose a simulator, and Run.

### Command line

```bash
cd ios_example
xcodebuild -project TiptapBridgeExample.xcodeproj -scheme TiptapBridgeExample \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build build

# Install and launch on an already booted simulator:
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/TiptapBridgeExample.app
xcrun simctl launch booted dev.tiptap.mobilebridge.example
```

Tap into the editor and type; use the toolbar to format the selection (the buttons send `exec`
and light up from `selectionChanged`), and Get JSON / Get HTML to fetch the content.

## Refresh the editor from the web build

The editor is authored once in [`web/`](../web). Rebuilding it runs a postbuild step that copies
the single inlined bundle into this app's resources (and the Flutter app's):

```bash
cd web
npm install
npm run build   # writes web/dist/index.html, then copies it to
                # ios_example/TiptapBridgeExample/Resources/editor.html
```

Do not hand edit `TiptapBridgeExample/Resources/editor.html`; it is generated from the web build.

## Layout

```
TiptapBridgeExample.xcodeproj            the Xcode project (open and Run)
TiptapBridgeExample/
  TiptapBridgeExampleApp.swift           app entry (@main)
  EditorScreen.swift                     the screen: native toolbar + webview + event line
  EditorWebView.swift                    UIViewRepresentable wrapping WKWebView
  TiptapBridge.swift                     the bridge: id-correlated commands, events, transport
  Resources/editor.html                  the built web bundle (generated, do not edit)
```

## Protocol

See [PROTOCOL.md](../PROTOCOL.md) for the wire contract (commands, events, errors) and
[GUIDE.md](../GUIDE.md#transport-per-platform) for the iOS transport notes.
