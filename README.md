# Tiptap Mobile Bridge

Run a [Tiptap](https://tiptap.dev) editor inside a webview and drive it from a native app
(Flutter / iOS / Android) over a small JSON message protocol. The editor renders in the
webview, so every Tiptap extension works as-is, while the native side sends commands and
receives events across the bridge.

A proof-of-concept with reference Flutter and iOS hosts.

## Layout

- **`web/`**: the Tiptap editor + JS bridge, built to a single inlined HTML file.
- **`flutter_example/`**: a reference native host (native toolbar + webview) using the bridge.
- **`ios_example/`**: the iOS counterpart, a native SwiftUI + WKWebView host at parity with Flutter.
- **`android_example/`**: the Android counterpart, a native Jetpack Compose + WebView host at parity.
- **`react_native_example/`**: the React Native counterpart, a bare RN + react-native-webview host at parity.

## Docs

- **[PROTOCOL.md](./PROTOCOL.md)**: the JSON wire contract (commands, events, host requests, errors, lifecycle).
- **[GUIDE.md](./GUIDE.md)**: architecture, setup, per-platform transport, using it in your own app.

## Quick start

```bash
cd web && npm install && npm run build    # builds + copies the bundle into both example apps
cd ../flutter_example && flutter run       # iOS simulator or device
```

Flutter, iOS, Android, and React Native all have runnable example hosts
([`flutter_example`](./flutter_example/README.md), [`ios_example`](./ios_example/README.md),
[`android_example`](./android_example/README.md),
[`react_native_example`](./react_native_example/README.md)). To put the bridge in your own app, see
[Use the bridge in your own app](./GUIDE.md#use-the-bridge-in-your-own-app).
