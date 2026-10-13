import PhotosUI
import SwiftUI
import UIKit

/// The single screen: a native toolbar over the editor webview. The toolbar's buttons send
/// `exec` commands and reflect active state, both carried over the JSON bridge; the editor
/// itself renders inside the (visible) webview below. Mirrors the Flutter reference app.
struct EditorScreen: View {
    @StateObject private var bridge = TiptapBridge()

    /// Content fetched by Get JSON / Get HTML, shown in a sheet.
    @State private var info: InfoText?

    /// URL entry state for the link prompt, the native counterpart to Flutter's `_promptLink` dialog.
    @State private var showLinkPrompt = false
    @State private var linkURL = ""

    /// Whether the native photo picker is presented.
    @State private var showImagePicker = false

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
            Text("event: \(bridge.lastEvent?.name ?? "(none)")")
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

                // The link button needs a URL before it can run setLink, so it prompts rather than
                // exec-ing directly. Rendered apart from ToolItem.all, mirroring Flutter's _promptLink.
                Button { showLinkPrompt = true } label: {
                    Image(systemName: "link").frame(minWidth: 28)
                }
                .buttonStyle(.bordered)
                .tint(isActive("link") ? .accentColor : .secondary)
                .accessibilityLabel("Link")

                Divider().frame(height: 24)

                Button("JSON") { fetch("getJSON") { try await bridge.getJSON() } }
                    .buttonStyle(.bordered)
                Button("HTML") { fetch("getHTML") { try await bridge.getHTML() } }
                    .buttonStyle(.bordered)

                // Open the native photo picker, then insert the chosen image over the bridge.
                Button {
                    showImagePicker = true
                } label: {
                    Image(systemName: "photo").frame(minWidth: 28)
                }
                .buttonStyle(.bordered)
                .accessibilityLabel("Insert image")
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
        .alert("Add link", isPresented: $showLinkPrompt) {
            TextField("https://example.com", text: $linkURL)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
            Button("Cancel", role: .cancel) { linkURL = "" }
            Button("Add") { applyLink() }
        }
        .sheet(isPresented: $showImagePicker) {
            ImagePicker { dataURL in
                showImagePicker = false
                guard let dataURL else { return }
                Task { try? await bridge.exec("setImage", [["src": dataURL]]) }
            }
        }
    }

    // MARK: Actions

    /// Initialize the editor once the page has loaded, then subscribe to focus/blur/update so the
    /// header event line lights up as the user interacts. Mirrors the Flutter onLoadStop hook.
    private func start() {
        Task {
            // Answer the editor's uploadImage host request with a placeholder URL (no real backend),
            // mirroring the Flutter app. Registered before init so a paste can never race ahead of it.
            bridge.onRequest("uploadImage") { _ in
                try await Task.sleep(for: .seconds(1))
                return "https://picsum.photos/400"
            }
            do {
                try await bridge.initEditor()
                try await bridge.subscribe("focus")
                try await bridge.subscribe("blur")
                try await bridge.subscribe("update")
            } catch {
                print("[tiptap] init failed: \(error)")
            }
        }
    }

    private func isActive(_ key: String) -> Bool {
        bridge.commandStates[key]?.isActive ?? false
    }

    /// Apply the URL entered in the link prompt as a link over the bridge, then clear the field.
    /// Empty input is a no-op, matching the Flutter prompt.
    private func applyLink() {
        let href = linkURL.trimmingCharacters(in: .whitespacesAndNewlines)
        linkURL = ""
        guard !href.isEmpty else { return }
        Task { try? await bridge.exec("setLink", [["href": href]]) }
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
        ToolItem(key: "underline", command: "toggleUnderline", args: nil, systemImage: "underline", label: "Underline"),
        ToolItem(key: "strike", command: "toggleStrike", args: nil, systemImage: "strikethrough", label: "Strikethrough"),
        ToolItem(key: "highlight", command: "toggleHighlight", args: nil, systemImage: "highlighter", label: "Highlight"),
        ToolItem(key: "h1", command: "toggleHeading", args: [["level": 1]], systemImage: "1.square", label: "Heading 1"),
        ToolItem(key: "h2", command: "toggleHeading", args: [["level": 2]], systemImage: "2.square", label: "Heading 2"),
        ToolItem(key: "bulletList", command: "toggleBulletList", args: nil, systemImage: "list.bullet", label: "Bullet list"),
        ToolItem(key: "taskList", command: "toggleTaskList", args: nil, systemImage: "checklist", label: "Task list"),
        ToolItem(key: "alignLeft", command: "setTextAlign", args: ["left"], systemImage: "text.alignleft", label: "Align left"),
        ToolItem(key: "alignCenter", command: "setTextAlign", args: ["center"], systemImage: "text.aligncenter", label: "Align center"),
        ToolItem(key: "alignRight", command: "setTextAlign", args: ["right"], systemImage: "text.alignright", label: "Align right"),
        ToolItem(key: "table", command: "insertTable", args: [["rows": 3, "cols": 3, "withHeaderRow": true] as [String: Any]], systemImage: "tablecells", label: "Insert table"),
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

/// A native photo picker (`PHPickerViewController`). Returns the chosen image as a base64 JPEG data
/// URL, or nil if the user cancels. PHPicker runs out of process, so it needs no photo permission.
struct ImagePicker: UIViewControllerRepresentable {
    let onPicked: (String?) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPicked: onPicked) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let onPicked: (String?) -> Void

        init(onPicked: @escaping (String?) -> Void) { self.onPicked = onPicked }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard let provider = results.first?.itemProvider, provider.canLoadObject(ofClass: UIImage.self) else {
                onPicked(nil)
                return
            }
            provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
                let dataURL = (object as? UIImage)
                    .flatMap { $0.jpegData(compressionQuality: 0.8) }
                    .map { "data:image/jpeg;base64,\($0.base64EncodedString())" }
                DispatchQueue.main.async { self?.onPicked(dataURL) }
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
