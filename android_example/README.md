# Android example (Jetpack Compose + WebView)

A native Android host for the Tiptap Mobile Bridge: a Jetpack Compose app that loads the editor into
an [`android.webkit.WebView`](https://developer.android.com/reference/android/webkit/WebView) and
drives it over the same JSON protocol as the Flutter and iOS examples. It is the Android counterpart
to [`flutter_example/`](../flutter_example) and [`ios_example/`](../ios_example), and the three share
the same web bundle and protocol.

## What it demonstrates

- Loads the built editor bundle from the app assets (offline, no server). `INTERNET` is declared only
  so images a host request returns from the network can display — e.g. the `uploadImage` demo's
  placeholder URL, as any real uploaded-image URL would.
- Outbound (editor to host) via an `AndroidTiptapBridge` `@JavascriptInterface`, so the web side
  detects the Android platform and routes messages here.
- Inbound (host to editor) via `evaluateJavascript("window.tiptapBridge.handleCommand(...)")`,
  passing the command JSON as a correctly escaped JS string literal (`JSONObject.quote`).
- Command responses correlated to their request by `id`, using a `CompletableDeferred` per command.
- On load: send `init`, then `subscribe` to `focus`, `blur`, and `update`. Received events are logged
  and the latest one is shown in the header.
- A native toolbar (bold, italic, underline, strike, highlight, headings, lists, align, link,
  table) whose buttons send `exec` commands and light up from `selectionChanged` state, plus Get
  JSON / Get HTML and a native photo picker that inserts the chosen image over the bridge.
- An `uploadImage` host request: pasting an image asks the host to upload it and inserts the returned
  URL (a placeholder here; see below). The round trip is verified end to end; whether a real clipboard
  image reaches the WebView paste event varies by Android/WebView version, so the native photo picker
  above is the always-reliable way to insert an image.

> `@JavascriptInterface` callbacks arrive on a background thread, so the bridge marshals every WebView
> call back to the main thread — the one Android-specific concern the Flutter and iOS hosts don't have.

## Requirements

- Android Studio (the bundled JDK is enough — no separate JDK needed), or a standalone JDK 17+ plus
  the Android SDK for command-line builds.
- An Android 7.0 (API 24) or newer emulator or device.

## Build and run

### Android Studio

Open the `android_example/` folder, let Gradle sync, choose an emulator or device, and Run.

### Command line

```bash
cd android_example
./gradlew :app:assembleDebug        # writes app/build/outputs/apk/debug/app-debug.apk

# Install and launch on a running emulator/device:
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n dev.tiptap.mobilebridge.example/.MainActivity
```

> Point Gradle at your SDK with a `local.properties` (`sdk.dir=/path/to/Android/sdk`) or the
> `ANDROID_HOME` environment variable. `local.properties` is machine-specific and gitignored.

Tap into the editor and type; use the toolbar to format the selection (the buttons send `exec` and
light up from `selectionChanged`), and Get JSON / Get HTML to fetch the content.

## Refresh the editor from the web build

The editor is authored once in [`web/`](../web). Rebuilding it runs a postbuild step that copies the
single inlined bundle into this app's assets (and the other example apps'):

```bash
cd web
npm install
npm run build   # writes web/dist/index.html, then copies it to
                # android_example/app/src/main/assets/editor.html
```

Do not hand edit `app/src/main/assets/editor.html`; it is generated from the web build.

## Layout

```
settings.gradle.kts / build.gradle.kts / gradle.properties   the Gradle project
gradlew / gradle/wrapper/                                     the committed Gradle wrapper (build out of the box)
app/
  build.gradle.kts                                           module config (Compose, SDK levels, deps)
  src/main/
    AndroidManifest.xml                                      the single launcher activity
    assets/editor.html                                       the built web bundle (generated, do not edit)
    java/dev/tiptap/mobilebridge/example/
      MainActivity.kt                                        app entry; hosts the Compose UI
      EditorScreen.kt                                        the screen: native toolbar + webview + event line
      EditorWebView.kt                                       AndroidView wrapping the WebView
      TiptapBridge.kt                                        the bridge: id-correlated commands, events, host requests
    res/values/                                              app name + theme
```

## Protocol

See [PROTOCOL.md](../PROTOCOL.md) for the wire contract (commands, events, host requests, errors) and
[GUIDE.md](../GUIDE.md#transport-per-platform) for the Android transport notes.
