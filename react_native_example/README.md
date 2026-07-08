# React Native example (react-native-webview)

A bare React Native host for the Tiptap Mobile Bridge: it loads the editor into a
[`react-native-webview`](https://github.com/react-native-webview/react-native-webview) and drives it
over the same JSON protocol as the Flutter and iOS examples. It is the React Native counterpart to
[`flutter_example/`](../flutter_example) and [`ios_example/`](../ios_example); all three share the
same web bundle and protocol.

## What it demonstrates

- Loads the built editor bundle inline (offline, no server) — the HTML is inlined into the JS
  bundle at build time (see below), so nothing is fetched or read from disk at runtime.
- Outbound (editor to host) via react-native-webview's `onMessage`
  (`window.ReactNativeWebView.postMessage`), so the web side detects the React Native platform and
  routes messages here.
- Inbound (host to editor) via `injectJavaScript("window.tiptapBridge.handleCommand(...)")`, passing
  the command JSON as a correctly escaped string literal.
- Command responses correlated to their request by `id`, using a promise map.
- On ready: send `init`, then `subscribe` to `focus`, `blur`, and `update`; the latest event is
  shown in the header.
- A native toolbar (bold, italic, underline, strike, highlight, headings, lists, align, link, table)
  whose buttons send `exec` commands and light up from `selectionChanged` state, plus Get JSON / Get
  HTML and a native image picker that inserts the chosen photo over the bridge.
- An `uploadImage` host request: the editor asks the host to upload a pasted image and inserts the
  returned URL (a placeholder here; see [the guide](../GUIDE.md#use-the-bridge-in-your-own-app)).

Two details are React Native specific. The editor bundle is an ES module, so `window.tiptapBridge`
may not exist the instant the page loads; `EditorWebView.tsx` polls for it and signals the host
before `init` (the same idea as the iOS host's `waitForBridge`). And the toolbar uses text labels,
not icons — React Native ships no icon set (unlike Flutter's Material icons / iOS SF Symbols), so
text avoids pulling in a native icon dependency.

## Requirements

- Node and the React Native toolchain (see [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment)).
- For iOS: Xcode and CocoaPods, plus an iOS simulator or device. This example is tested on iOS.

## Build and run

```bash
cd react_native_example
npm install
cd ios && pod install && cd ..
npm run ios        # builds and launches on an iOS simulator
```

Tap into the editor and type; use the toolbar to format the selection (the buttons send `exec` and
light up from `selectionChanged`), and Get JSON / Get HTML to fetch the content.

## Refresh the editor from the web build

The editor is authored once in [`web/`](../web). Rebuilding it runs a postbuild step that copies the
single inlined bundle into this app (and the other example apps):

```bash
cd web
npm install
npm run build   # writes web/dist/index.html, then copies it to react_native_example/editor.html
```

Do not hand edit `editor.html`; it is generated from the web build. It is inlined into the JS bundle
as a string at build time by `babel-plugin-inline-import` (see `babel.config.js`), which loads
reliably on both iOS and Android — unlike loading a local file, which react-native-webview does not
support in release builds.

## Layout

```
App.tsx                  app entry (renders EditorScreen)
src/
  TiptapBridge.ts        the bridge: id-correlated commands, events, host requests
  EditorWebView.tsx      react-native-webview wrapper + bridge-ready handshake
  EditorScreen.tsx       the screen: native toolbar + webview + event line
  html.d.ts              lets `import './editor.html'` resolve to the bundle as a string
editor.html              the built web bundle (generated, do not edit)
babel.config.js          inlines editor.html as a string (babel-plugin-inline-import)
```

## Using this in an Expo app

The reusable parts — `TiptapBridge.ts` and `EditorWebView.tsx` — are framework-agnostic: they depend
only on `react-native-webview`, which works the same in a bare and an Expo app. To run the example
UI under Expo, swap `react-native-image-picker` for
[`expo-image-picker`](https://docs.expo.dev/versions/latest/sdk/imagepicker/) in the image button and
start it with `expo`. The bridge itself needs no changes.

## Protocol

See [PROTOCOL.md](../PROTOCOL.md) for the wire contract (commands, events, host requests, errors) and
[GUIDE.md](../GUIDE.md#transport-per-platform) for the React Native transport notes.
