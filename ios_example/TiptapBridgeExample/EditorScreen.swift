import SwiftUI

/// The single screen: a native toolbar over the editor webview. The toolbar's buttons send
/// `exec` commands and reflect active state, both carried over the JSON bridge; the editor
/// itself renders inside the (visible) webview below. Mirrors the Flutter reference app.
struct EditorScreen: View {
    @StateObject private var bridge = TiptapBridge()

    /// Content fetched by Get JSON / Get HTML, shown in a sheet.
    @State private var info: InfoText?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            toolbar
            Divider()
            EditorWebView(bridge: bridge, onReady: start)
        }
        .sheet(item: $info) { item in
            ContentSheet(item: item)
        }
    }

    // MARK: Sections

    private var header: some View {
        HStack {
            Text("Tiptap Mobile Bridge").font(.headline)
            Spacer()
            // The latest editor event received over the bridge (driven by the subscribe()
            // calls in start()); proves "receive events" end to end.
            Text("event: \(bridge.lastEvent ?? "(none)")")
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospaced()
        }
        .padding(.horizontal)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    private var toolbar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ToolItem.all) { item in
                    Button {
                        Task { try? await bridge.exec(item.command, item.args) }
                    } label: {
                        Image(systemName: item.systemImage)
                            .frame(minWidth: 28)
                    }
                    .buttonStyle(.bordered)
                    .tint(isActive(item.key) ? .accentColor : .secondary)
                    .accessibilityLabel(item.label)
                }

                Divider().frame(height: 24)

                Button("JSON") { fetch("getJSON") { try await bridge.getJSON() } }
                    .buttonStyle(.bordered)
                Button("HTML") { fetch("getHTML") { try await bridge.getHTML() } }
                    .buttonStyle(.bordered)
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
    }

    // MARK: Actions

    /// Initialize the editor once the page has loaded, then subscribe to focus/blur so the
    /// header event line lights up as the user interacts. Mirrors the Flutter onLoadStop hook.
    private func start() {
        Task {
            do {
                try await bridge.initEditor()
                try await bridge.subscribe("focus")
                try await bridge.subscribe("blur")
            } catch {
                print("[tiptap] init failed: \(error)")
            }
        }
    }

    private func isActive(_ key: String) -> Bool {
        bridge.commandStates[key]?.isActive ?? false
    }

    /// Run a content-fetch command and present its result (or the error) in the sheet.
    private func fetch(_ title: String, _ operation: @escaping () async throws -> Any?) {
        Task {
            do {
                info = InfoText(title: title, body: stringify(try await operation()))
            } catch {
                info = InfoText(title: "\(title) failed", body: "\(error)")
            }
        }
    }
}

/// A toolbar button's wiring: the bridge `key` to read active state by, the Tiptap `command`
/// to run via `exec`, its icon, and optional positional args. Mirrors a web-side
/// `TOOLBAR_COMMANDS` entry (key + command + args).
private struct ToolItem: Identifiable {
    let key: String
    let command: String
    let args: [Any]?
    let systemImage: String
    let label: String

    var id: String { key }

    static let all: [ToolItem] = [
        ToolItem(key: "bold", command: "toggleBold", args: nil, systemImage: "bold", label: "Bold"),
        ToolItem(key: "italic", command: "toggleItalic", args: nil, systemImage: "italic", label: "Italic"),
        ToolItem(key: "h1", command: "toggleHeading", args: [["level": 1]], systemImage: "1.square", label: "Heading 1"),
        ToolItem(key: "bulletList", command: "toggleBulletList", args: nil, systemImage: "list.bullet", label: "Bullet list"),
    ]
}

/// Result of a Get JSON / Get HTML fetch, shown in a sheet.
private struct InfoText: Identifiable {
    let id = UUID()
    let title: String
    let body: String
}

private struct ContentSheet: View {
    let item: InfoText
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(item.body)
                    .font(.system(.footnote, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding()
            }
            .navigationTitle(item.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// Render a response value for display: HTML comes back as a String; JSON (a ProseMirror
/// document) is pretty-printed.
private func stringify(_ value: Any?) -> String {
    switch value {
    case let string as String:
        return string
    case .some(let object) where JSONSerialization.isValidJSONObject(object):
        if let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
           let string = String(data: data, encoding: .utf8) {
            return string
        }
        return String(describing: object)
    case .some(let other):
        return String(describing: other)
    case .none:
        return "(no result)"
    }
}
