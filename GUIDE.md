# Tiptap Mobile Bridge Integration Guide

How to drive a Tiptap editor from a native app (Flutter / iOS / Android / React Native) by running the
editor in a webview and talking to it over a small JSON protocol. For the wire format see
[PROTOCOL.md](./PROTOCOL.md); this guide is the practical how-to.

## Architecture

```
┌─────────────────────────── native app ───────────────────────────┐
│                                                                   │
│   native chrome (toolbar, menus)                                  │
│        │  exec / getJSON / …            selectionChanged / …      │
│        ▼            commands  │   ▲  events                        │
│   ┌────────────┐    (JSON)    │   │   (JSON)                       │
│   │   bridge   │──────────────┼───┼──────────────┐                │
│   └────────────┘              ▼   │              │                │
│   ┌──────────────────────────────────────────────▼─────────────┐ │
│   │  webview  →  Tiptap editor (StarterKit + your extensions)   │ │
│   └────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

- **The webview renders the editor; native renders only the chrome.** This is the proven,
  low-risk path (how TenTap / Notion-style apps work) and it keeps **Tiptap's full extension
  model**: a custom extension is just normal web code that renders in the webview, no native
  port required.
- **The protocol and the web bundle are shared across all platforms.** Only the thin native
  *transport* differs per platform.
- The web side is built to a **single, self-contained HTML file** (everything inlined), so the
  host loads it straight from the device filesystem, with no network or asset requests.

## Repo layout

```
web/                      TypeScript editor + bridge (the shared, platform-agnostic half)
  src/protocol.ts         the wire contract (types)
  src/bridge.ts           transport + platform auto-detection
  src/main.ts             the editor (StarterKit) + command/event handling
  src/dev-host.ts         in-browser "native host" simulator (dev only)
  index.html              production mount point (#editor)
  dev.html                loads the dev host
  vite.config.ts          single-file build (vite-plugin-singlefile)

flutter_example/          reference Flutter host (native toolbar + webview)
  lib/tiptap_bridge.dart  the bridge: id-correlated commands, events via a JS handler
  lib/main.dart           the app: a native toolbar + the webview
  assets/editor.html      the built web bundle (copied from web/dist/index.html)
ios_example/              reference iOS host (SwiftUI + WKWebView), at parity with Flutter
  TiptapBridgeExample/    the Swift bridge, screen, and WKWebView wrapper
react_native_example/     reference React Native host (react-native-webview), at parity
  src/TiptapBridge.ts     the bridge: id-correlated commands, events, host requests
  src/EditorWebView.tsx   the react-native-webview wrapper + bridge-ready handshake
  src/EditorScreen.tsx    the app: a native toolbar + the webview
  editor.html             the built web bundle (copied from web/dist/index.html)
```

## Quick start

**1. Build the editor bundle** (the `postbuild` script auto-copies it into the host's assets):

```bash
cd web
npm install
npm run build           # → web/dist/index.html, then copied into both example apps (Flutter + iOS)
```

**2. Run the reference app** (iOS simulator or a real device):

```bash
cd flutter_example
flutter run
```

Tap into the editor and type; use the native toolbar (bold / italic / underline / strike /
highlight / H1 / H2 / lists / task list / align / link / table / image): its buttons send `exec`
commands and light up from `selectionChanged` state, both over the bridge.

## Test without a device

The dev host drives the **exact** command-dispatch / event-emit logic that runs on a device,
from a plain browser tab (over the browser `postMessage` transport):

```bash
cd web
npm install
npm run dev             # open the printed URL, then add /dev.html
```

Click **init** first, then the formatting buttons; the log shows every command and the
responses/events coming back. No native toolchain needed.

## Transport per platform

Every host carries the protocol's directions over one message channel. **Inbound** is identical
everywhere; only the **outbound** carrier differs. The web side ([`bridge.ts`](./web/src/bridge.ts))
auto-detects the platform (order: flutter → ios → android → react native → browser).

- **Inbound (host → editor), all platforms:** evaluate JS that calls
  `window.tiptapBridge.handleCommand("<json>")` for a command, or
  `window.tiptapBridge.handleReply("<json>")` to answer an editor-initiated host request.
- **Outbound (editor → host):** command responses, events, and host requests; see each platform below.

Async results are correlated by the command `id` **in the host**, not by any transport return
value, so a plain one-way message channel is enough on every platform.

### Flutter: implemented and tested ([`tiptap_bridge.dart`](./flutter_example/lib/tiptap_bridge.dart))

Outbound uses a registered JS handler; inbound uses `evaluateJavascript`:

```dart
// Outbound: editor → host. The web side calls
//   window.flutter_inappwebview.callHandler('tiptapBridge', json)
controller.addJavaScriptHandler(
  handlerName: 'tiptapBridge',
  callback: (args) => _onMessage(jsonDecode(args.first as String)),
);

// Inbound: host → editor, plus id correlation for the response.
Future<Object?> _send(String name, {Map<String, dynamic>? params}) {
  final id = '${_nextId++}';
  final completer = Completer<Object?>();
  _pending[id] = completer;                          // resolved when the response with this id arrives
  final command = {'type': 'command', 'id': id, 'name': name, if (params != null) 'params': params};
  controller.evaluateJavascript(
    source: 'window.tiptapBridge.handleCommand(${jsonEncode(jsonEncode(command))})',
  );
  return completer.future;
}
```

The editor can also send a host request the other way; the host answers it by calling
`window.tiptapBridge.handleReply(...)` from a `type == 'hostRequest'` message, using the same
double-encode as `_send`. `main.dart` registers the handlers with `bridge.onRequest(name, ...)`.

In `main.dart` the webview loads the bundle and inits it once loaded:

```dart
InAppWebView(
  initialFile: 'assets/editor.html',
  onWebViewCreated: _bridge.attach,
  onLoadStop: (controller, url) { _bridge.init(); },
)
```

> The bundle must be declared as a Flutter asset (`pubspec.yaml` → `flutter: assets: - assets/editor.html`).

### iOS / WKWebView: implemented and tested ([`ios_example`](./ios_example))

Outbound via a script-message handler; inbound via `evaluateJavaScript`:

```swift
// Outbound: editor → host. The web side calls
//   window.webkit.messageHandlers.tiptapBridge.postMessage(json)
let config = WKWebViewConfiguration()
config.userContentController.add(self, name: "tiptapBridge")
// func userContentController(_:didReceive message: WKScriptMessage) { let json = message.body as! String; … }

// Inbound: host → editor. Encode the command JSON as a JS string literal (escapes it),
// then call the entry point, the same idea as Flutter's double-encode.
let literal = String(data: try! JSONSerialization.data(withJSONObject: commandJson, options: .fragmentsAllowed), encoding: .utf8)!
webView.evaluateJavaScript("window.tiptapBridge.handleCommand(\(literal))")
```

> Send the first command only after `window.tiptapBridge` exists: `WKWebView`'s `didFinish` can
> fire before the editor's module installs it, so poll for it before `init` (see
> `ios_example`'s `EditorWebView.swift`).

### Android / WebView: reference wiring

Outbound via a `@JavascriptInterface`; inbound via `evaluateJavascript`:

```kotlin
// Outbound: editor → host. The web side calls
//   window.AndroidTiptapBridge.postMessage(json)
webView.addJavascriptInterface(object {
  @JavascriptInterface fun postMessage(json: String) { /* parse + dispatch */ }
}, "AndroidTiptapBridge")

// Inbound: host → editor.
webView.evaluateJavascript("window.tiptapBridge.handleCommand(${JSONObject.quote(jsonString)})", null)
```

### React Native / react-native-webview: implemented and tested ([`react_native_example`](./react_native_example))

Outbound uses react-native-webview's message channel; inbound uses `injectJavaScript`:

```tsx
// Outbound: editor → host. The web side calls window.ReactNativeWebView.postMessage(json).
// react-native-webview delivers it to the onMessage prop — which MUST be set, or the web side's
// window.ReactNativeWebView is never injected and the platform is not detected.
<WebView onMessage={(e) => bridge.handleMessage(e.nativeEvent.data)} /* … */ />

// Inbound: host → editor. Encode the command JSON as a JS string literal (escapes it), then call
// the entry point — the same double-encode as Flutter/iOS.
webviewRef.current?.injectJavaScript(`window.tiptapBridge.handleCommand(${literal}); true;`)
```

> Three React Native specifics: `injectJavaScript` returns nothing (no success or error, unlike
> `evaluateJavaScript`), so the bridge adds a per-command timeout for the same "caller never hangs"
> guarantee, and the injected script must end with `true;`. The editor bundle is an ES module, so
> `window.tiptapBridge` can lag the page load; the host polls for it in `injectedJavaScript` and
> signals before `init` (see `react_native_example`'s `EditorWebView.tsx`). Load the bundle as
> inline HTML (`source={{ html }}` with `originWhitelist={['*']}`) — react-native-webview does not
> load local files in release builds. The bridge is framework-agnostic, so the same code runs under
> Expo (swap the image picker).

### Browser: dev only

Every direction uses `window.postMessage` with `source` tags (`tiptap-host` inbound, including host
replies; `tiptap-editor` outbound, including host requests); this is exactly what the dev host uses.

> The **Flutter**, **iOS**, and **React Native** hosts are implemented and tested in this POC
> (`flutter_example/`, `ios_example/`, and `react_native_example/`). The Android snippet is the
> reference wiring the protocol expects; the web side already detects and targets all five carriers.

## Use the bridge in your own app

The example apps are runnable hosts, but the goal is to drop the bridge into *your* app. Two
parts are reusable as-is; the rest is example UI you replace:

- **The web bundle** (the editor plus the protocol): you own and customize it.
- **The native bridge** (one self-contained file per platform): copy it in.

A real integration is six steps:

1. **Take the web project.** Copy [`web/`](./web) into your repo. It is a small Vite project (a
   few source files plus a single-file build config), and it is the editor you ship.
2. **Use your own extensions.** The extension set is the one place the bundle is yours, not
   generic. Edit the `extensions` array in [`web/src/main.ts`](./web/src/main.ts) to what your app
   needs (it is `StarterKit` plus a few defaults today). This is plain Tiptap with no native code;
   see [Adding a custom extension](#adding-a-custom-extension).
3. **Build the bundle.** `npm run build` writes `web/dist/index.html`, a single inlined file with
   no network or asset requests. A `postbuild` step copies it into the example apps; point it (or
   copy by hand) into *your* app's assets instead.
4. **Copy the native bridge.** It has no dependency on the example UI:
   [`tiptap_bridge.dart`](./flutter_example/lib/tiptap_bridge.dart) for Flutter,
   [`TiptapBridge.swift`](./ios_example/TiptapBridgeExample/TiptapBridge.swift) plus
   `EditorWebView.swift` for iOS, or
   [`TiptapBridge.ts`](./react_native_example/src/TiptapBridge.ts) plus `EditorWebView.tsx` for
   React Native. Load the built bundle into a webview and `attach` the bridge.
5. **Build your toolbar.** A toolbar button is just `exec(command, args)`, reading active state
   from the `selectionChanged` event. Render your own UI and call the bridge the same way; keep its
   command keys in sync with `TOOLBAR_COMMANDS` in `main.ts` (the
   [gotcha](#gotcha-probing-cans-side-effects) below is why that list is an allowlist).
6. **Replace the demo upload.** The example `uploadImage` handler returns a placeholder URL
   (`https://picsum.photos/400`) with no real backend. Swap it for your real upload before
   shipping, or every image will resolve to the placeholder. The channel is the
   [host request](./PROTOCOL.md) part of the protocol.

There is no package to install: you copy the web project and the one native file and own them,
which keeps every part open to change. If your editor differs only by extensions and toolbar,
those are exactly steps 2 and 5.

## Adding a custom extension

Because the editor lives in the webview, a custom extension is plain Tiptap with no native code.
Add it to the `extensions` array in [`web/src/main.ts`](./web/src/main.ts) and rebuild (see
[Quick start](#quick-start)); it is then reachable from native with no per-command glue:

```dart
bridge.exec('myCommand', ['arg']);   // args are positional, spread into the command
```

For a toolbar button that reflects active state, add the command to `TOOLBAR_COMMANDS` in `main.ts`
(see the [gotcha](#gotcha-probing-cans-side-effects) for why that list is an allowlist).

`schemaReady` reports the live `nodes` / `marks` / `commands` at runtime, so a host can discover
what an editor build supports instead of hard-coding it.

## Gotcha: probing `can()`'s side-effects

This bit us during the POC and is the single most important thing to get right when building
toolbar state for *any* host.

- **Symptom:** typing in the editor dropped focus after about one keystroke on iOS.
- **Cause:** to enable/disable toolbar buttons we probed each command with
  `editor.can()[name]()`. `can()` runs a command in dry-run mode, but **some Tiptap commands
  don't gate their side-effects behind `dispatch`**. `blur` unconditionally schedules
  `requestAnimationFrame(() => view.dom.blur())`. So probing *every* command on each selection
  change (i.e. every keystroke) blurred the editor a frame (~16 ms) later.
- **How we proved it:** a focus/key event probe inside the webview showed `blur` firing ~16 ms
  (one `requestAnimationFrame` at 60 fps) after each `input`, and it still fired with all
  native messaging stubbed out, which pointed at the editor side, not the transport.
- **Fix:** probe only an **allowlist** of the commands the toolbar actually renders
  (`TOOLBAR_COMMANDS` in [`main.ts`](./web/src/main.ts)), never the full `editor.commands` set.
  A denylist would silently break the day someone adds another unguarded command.

**Takeaway:** never enumerate `can()` over all commands to build UI state. Probe exactly the
commands you render.

## Security

Treat everything the editor returns (`getJSON` / `getHTML`) as untrusted user input. The content
you pass to `init` / `setContent` is parsed against the editor's schema, which drops tags and
attributes it doesn't recognize — but schema parsing is **not** sanitization. Validate and sanitize
on your server before you store the document or render it anywhere outside this editor.

The bundle is loaded from the device filesystem with nothing fetched from the network — keep it that
way. Don't point the webview at remote, untrusted HTML, and have your `uploadImage` (and any other
host-request) handler validate what it accepts before acting on it.

## Keyboard / focus on the iOS simulator

- The simulator hides the on-screen keyboard while **I/O ▸ Keyboard ▸ Connect Hardware
  Keyboard** is on. Type with your Mac keyboard, or toggle it off for the soft keyboard.
- With the `can()`/`blur` fix in place, typing holds focus. If you ever see focus loss again,
  rule out a command-probe side-effect (above) before suspecting the platform.
