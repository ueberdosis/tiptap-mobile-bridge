import SwiftUI

/// Minimal SwiftUI host that drives a Tiptap editor (running in a WKWebView) over the JSON
/// bridge protocol. The native iOS counterpart to the Flutter reference app.
@main
struct TiptapBridgeExampleApp: App {
    var body: some Scene {
        WindowGroup {
            EditorScreen()
        }
    }
}
