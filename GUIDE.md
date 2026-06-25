# Tiptap Mobile Bridge — Integration Guide

How to drive a Tiptap editor from a native app (Flutter / iOS / Android) by running the
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
  model** — a custom extension is just normal web code that renders in the webview, no native
  port required.
- **The protocol and the web bundle are shared across all platforms.** Only the thin native
  *transport* differs per platform.
- The web side is built to a **single, self-contained HTML file** (everything inlined), so the
  host loads it straight from the device filesystem — no network, no asset requests.

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

flutter_example/          reference native host (the implemented, tested platform)
  lib/tiptap_bridge.dart  the bridge: id-correlated commands, events via a JS handler
  lib/main.dart           the app: a native toolbar + the webview
  assets/editor.html      the built web bundle (copied from web/dist/index.html)
```

## Quick start

**1. Build the editor bundle** (the `postbuild` script auto-copies it into the host's assets):

```bash
cd web
npm install
npm run build           # → web/dist/index.html, then copied to flutter_example/assets/editor.html
```

**2. Run the reference app** (iOS simulator or a real device):

```bash
cd flutter_example
flutter run
```

Tap into the editor and type; use the native toolbar (bold / italic / underline / strike /
highlight / H1 / H2 / lists / task list / align / link / table) — its buttons send `exec`
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
auto-detects the platform (order: flutter → ios → android → browser).

- **Inbound (host → editor), all platforms:** evaluate JS that calls
  `window.tiptapBridge.handleCommand("<json>")` for a command, or
  `window.tiptapBridge.handleReply("<json>")` to answer an editor-initiated host request.
- **Outbound (editor → host):** command responses, events, and host requests; see each platform below.

Async results are correlated by the command `id` **in the host**, not by any transport return
value — so a plain one-way message channel is enough on every platform.

### Flutter — implemented & tested ([`tiptap_bridge.dart`](./flutter_example/lib/tiptap_bridge.dart))

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

### iOS / WKWebView — reference wiring

Outbound via a script-message handler; inbound via `evaluateJavaScript`:

```swift
// Outbound: editor → host. The web side calls
//   window.webkit.messageHandlers.tiptapBridge.postMessage(json)
let config = WKWebViewConfiguration()
config.userContentController.add(self, name: "tiptapBridge")
// func userContentController(_:didReceive message: WKScriptMessage) { let json = message.body as! String; … }

// Inbound: host → editor. Encode the command JSON as a JS string literal (escapes it),
// then call the entry point — same idea as Flutter's double-encode.
let literal = String(data: try! JSONSerialization.data(withJSONObject: commandJson, options: .fragmentsAllowed), encoding: .utf8)!
webView.evaluateJavaScript("window.tiptapBridge.handleCommand(\(literal))")
```

### Android / WebView — reference wiring

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

### Browser — dev only

Every direction uses `window.postMessage` with `source` tags (`tiptap-host` inbound, including host
replies; `tiptap-editor` outbound, including host requests); this is exactly what the dev host uses.

> Only the **Flutter** host is implemented and tested in this POC. The iOS/Android snippets
> are the reference wiring the protocol expects — the web side already detects and targets
> all four carriers.

## Adding a custom extension

Because the editor lives in the webview, a custom extension is **plain Tiptap — no native
code**:

1. Add it to the editor in [`web/src/main.ts`](./web/src/main.ts):
   ```ts
   extensions: [StarterKit, MyExtension],
   ```
2. Rebuild the bundle and recopy it (see [Quick start](#quick-start)).
3. Drive it from native with `exec` and the command name (args are positional):
   ```dart
   bridge.exec('myCommand', ['arg']);
   ```
4. If you want a **toolbar button that reflects active state**, add its command to
   `TOOLBAR_COMMANDS` in `main.ts` (and add the native button). Read the gotcha below first —
   that list is an allowlist on purpose.

`schemaReady` reports the live `nodes` / `marks` / `commands` at runtime, so a host can
discover what an editor build supports instead of hard-coding it.

## Gotcha: probing `can()`'s side-effects

This bit us during the POC and is the single most important thing to get right when building
toolbar state for *any* host.

- **Symptom:** typing in the editor dropped focus after about one keystroke on iOS.
- **Cause:** to enable/disable toolbar buttons we probed each command with
  `editor.can()[name]()`. `can()` runs a command in dry-run mode — but **some Tiptap commands
  don't gate their side-effects behind `dispatch`**. `blur` unconditionally schedules
  `requestAnimationFrame(() => view.dom.blur())`. So probing *every* command on each selection
  change (i.e. every keystroke) blurred the editor a frame (~16 ms) later.
- **How we proved it:** a focus/key event probe inside the webview showed `blur` firing ~16 ms
  (one `requestAnimationFrame` at 60 fps) after each `input` — and it still fired with all
  native messaging stubbed out, which is what pointed at the editor side, not the transport.
- **Fix:** probe only an **allowlist** of the commands the toolbar actually renders
  (`TOOLBAR_COMMANDS` in [`main.ts`](./web/src/main.ts)), never the full `editor.commands` set.
  A denylist would silently break the day someone adds another unguarded command.

**Takeaway:** never enumerate `can()` over all commands to build UI state. Probe exactly the
commands you render.

## Keyboard / focus on the iOS simulator

- The simulator hides the on-screen keyboard while **I/O ▸ Keyboard ▸ Connect Hardware
  Keyboard** is on — type with your Mac keyboard, or toggle it off for the soft keyboard.
- With the `can()`/`blur` fix in place, typing holds focus. If you ever see focus loss again,
  rule out a command-probe side-effect (above) before suspecting the platform.
