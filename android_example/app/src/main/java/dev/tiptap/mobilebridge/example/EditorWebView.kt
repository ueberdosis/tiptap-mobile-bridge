package dev.tiptap.mobilebridge.example

import android.annotation.SuppressLint
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView

/**
 * A [WebView] that hosts the bundled Tiptap editor and wires it to a [TiptapBridge].
 *
 * On creation it registers the `AndroidTiptapBridge` @JavascriptInterface (so the editor detects the
 * Android platform and routes outbound messages here) and loads `editor.html` from the app assets
 * (offline, no server). [onReady] fires once the page has loaded and the inbound bridge is
 * installed, which is when the host should send `init`. Mirrors iOS's EditorWebView.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun EditorWebView(bridge: TiptapBridge, onReady: () -> Unit, modifier: Modifier = Modifier) {
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                settings.allowFileAccess = true
                // Mirrors iOS's isInspectable: lets `chrome://inspect` attach to the editor.
                WebView.setWebContentsDebuggingEnabled(true)

                // Outbound: editor -> host. The web side calls
                // window.AndroidTiptapBridge.postMessage(json) on the JavaBridge thread; the bridge
                // marshals to the main thread from there.
                addJavascriptInterface(
                    object {
                        @JavascriptInterface
                        fun postMessage(json: String) {
                            bridge.handle(json)
                        }
                    },
                    "AndroidTiptapBridge",
                )

                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String?) {
                        waitForBridge(view, attemptsLeft = 40, onReady = onReady)
                    }
                }

                bridge.attach(this)
                // Everything is inlined into this one file, so it loads offline with no sub-requests.
                loadUrl("file:///android_asset/editor.html")
            }
        },
    )
}

/**
 * Poll for the editor's inbound bridge, then fire [onReady]. The bundle is an ES module, so
 * `window.tiptapBridge` is not guaranteed to exist the instant `onPageFinished` fires (module
 * execution can lag it). Retries every 50ms (up to ~2s) to absorb that gap, then gives up and fires
 * anyway so a genuine failure still surfaces in logs rather than hanging silently. Mirrors iOS's
 * `waitForBridge`.
 */
private fun waitForBridge(view: WebView, attemptsLeft: Int, onReady: () -> Unit) {
    view.evaluateJavascript("!!(window.tiptapBridge && window.tiptapBridge.handleCommand)") { ready ->
        when {
            ready == "true" -> onReady()
            attemptsLeft > 0 -> view.postDelayed({ waitForBridge(view, attemptsLeft - 1, onReady) }, 50)
            else -> onReady()
        }
    }
}
