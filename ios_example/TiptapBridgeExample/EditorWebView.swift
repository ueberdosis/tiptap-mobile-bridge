import SwiftUI
import WebKit

/// A `WKWebView` that hosts the bundled Tiptap editor and wires it to a `TiptapBridge`.
///
/// On creation it registers the `tiptapBridge` script-message handler (so the editor detects
/// the iOS platform and routes outbound messages here) and loads `editor.html` from the app
/// bundle (offline, no server). `onReady` fires once the page has loaded and the inbound bridge
/// is installed, which is when the host should send `init`.
struct EditorWebView: UIViewRepresentable {
    let bridge: TiptapBridge
    let onReady: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(bridge: bridge, onReady: onReady)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // A weak proxy keeps the userContentController from retaining the coordinator, which
        // would otherwise form a WKWebView <-> message-handler retain cycle.
        configuration.userContentController.add(
            WeakScriptMessageHandler(context.coordinator),
            name: "tiptapBridge"
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.keyboardDismissMode = .interactive
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        bridge.attach(webView)
        load(into: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    /// Load the self-contained editor bundle from the app's resources.
    private func load(into webView: WKWebView) {
        guard let url = Bundle.main.url(forResource: "editor", withExtension: "html") else {
            webView.loadHTMLString(
                "<h2 style=\"font-family:-apple-system\">editor.html is missing from the app bundle.</h2>",
                baseURL: nil
            )
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private let bridge: TiptapBridge
        private let onReady: () -> Void

        init(bridge: TiptapBridge, onReady: @escaping () -> Void) {
            self.bridge = bridge
            self.onReady = onReady
        }

        // Outbound: editor -> host. The web side calls
        // window.webkit.messageHandlers.tiptapBridge.postMessage(json).
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            let body = message.body
            Task { @MainActor in bridge.handle(message: body) }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // The editor bundle is an ES module, so `window.tiptapBridge` is not guaranteed to
            // exist the instant navigation finishes (module execution can lag didFinish). Poll
            // until the inbound bridge is installed before firing onReady, which sends `init`.
            waitForBridge(webView, attemptsLeft: 40)
        }

        /// Poll for the editor's inbound bridge, then fire onReady. Retries every 50ms (up to
        /// about 2s) to absorb the gap between didFinish and module execution, then gives up and
        /// fires anyway so a genuine failure still surfaces in logs rather than hanging silently.
        private func waitForBridge(_ webView: WKWebView, attemptsLeft: Int) {
            webView.evaluateJavaScript("!!(window.tiptapBridge && window.tiptapBridge.handleCommand)") { [weak self] ready, _ in
                guard let self else { return }
                if ready as? Bool == true {
                    self.onReady()
                } else if attemptsLeft > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                        self.waitForBridge(webView, attemptsLeft: attemptsLeft - 1)
                    }
                } else {
                    self.onReady()
                }
            }
        }
    }
}

/// Forwards script messages to `target` without retaining it, so a `WKUserContentController`
/// can hold this proxy instead of the real handler and avoid a retain cycle.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
