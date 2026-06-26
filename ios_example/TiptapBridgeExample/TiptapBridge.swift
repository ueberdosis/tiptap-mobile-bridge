import Foundation
import WebKit

/// Whether a command can run, and whether its mark/node is active at the selection.
/// Mirrors the `CommandState` carried in the `selectionChanged` event payload.
struct CommandState: Equatable {
    let canExec: Bool
    let isActive: Bool
}

/// A generic editor event forwarded over the bridge. `name` is the event name
/// (`ready`, `selectionChanged`, `focus`, `blur`, ...); `payload` is its JSON projection.
struct TiptapEvent {
    let name: String
    let payload: [String: Any]
}

/// A failed command response, surfaced as a thrown error to the awaiting caller.
struct TiptapError: Error, LocalizedError {
    let code: String
    let message: String
    var errorDescription: String? { "\(code): \(message)" }
}

/// Drives a Tiptap editor running inside a `WKWebView` over the JSON protocol.
///
/// Commands are sent to the editor via `window.tiptapBridge.handleCommand`; events and
/// responses arrive through the `tiptapBridge` script-message handler. Async commands
/// (e.g. `getJSON`) are correlated to their response by `id`. State that drives SwiftUI
/// (`commandStates`, `lastEvent`) is published; all access happens on the main actor.
@MainActor
final class TiptapBridge: NSObject, ObservableObject {
    /// Latest per-command state (from `selectionChanged`); drives toolbar active styling.
    @Published private(set) var commandStates: [String: CommandState] = [:]

    /// Name of the most recent event received over the bridge (drives the demo event line).
    @Published private(set) var lastEvent: String?

    private weak var webView: WKWebView?
    private var nextId = 1
    private var pending: [String: CheckedContinuation<Any?, Error>] = [:]

    /// Handlers the editor can invoke via a host request, keyed by request name. See `onRequest`.
    private var requestHandlers: [String: ([String: Any]) async throws -> Any?] = [:]

    /// Wire up the webview the bridge sends commands into. Inbound messages are delivered
    /// separately via the script-message handler (see `handle(message:)`).
    func attach(_ webView: WKWebView) {
        self.webView = webView
    }

    // MARK: Inbound (editor -> host)

    /// Decode and dispatch one inbound message body (a JSON string) from the editor.
    func handle(message body: Any) {
        guard
            let json = body as? String,
            let data = json.data(using: .utf8),
            let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        onMessage(message)
    }

    private func onMessage(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "response":
            guard let id = message["id"] as? String, let continuation = pending.removeValue(forKey: id) else { return }
            if message["ok"] as? Bool == true {
                continuation.resume(returning: message["result"])
            } else {
                let error = message["error"] as? [String: Any]
                continuation.resume(throwing: TiptapError(
                    code: error?["code"] as? String ?? "COMMAND_FAILED",
                    message: error?["message"] as? String ?? "command failed"
                ))
            }
        case "event":
            let name = message["name"] as? String ?? ""
            let payload = message["payload"] as? [String: Any] ?? [:]
            if name == "selectionChanged", let states = payload["commandStates"] as? [String: Any] {
                commandStates = states.mapValues { value in
                    let entry = value as? [String: Any]
                    return CommandState(
                        canExec: entry?["canExec"] as? Bool == true,
                        isActive: entry?["isActive"] as? Bool == true
                    )
                }
            }
            lastEvent = name
            print("[tiptap] event: \(name)")
        case "hostRequest":
            handleHostRequest(message)
        default:
            break
        }
    }

    // MARK: Host requests (editor -> host -> editor)

    /// Register a handler the editor can invoke via a host request (e.g. `uploadImage`). The
    /// handler's resolved value becomes the reply `result`; a thrown error becomes the reply
    /// `error`. One handler per name: registering an existing name replaces it.
    func onRequest(_ name: String, _ handler: @escaping ([String: Any]) async throws -> Any?) {
        requestHandlers[name] = handler
    }

    /// Route an inbound host request to its registered handler and reply with the outcome: the
    /// handler's resolved value as `result`, an unknown name or a thrown error as `error`. Mirrors
    /// the Flutter host's `_handleHostRequest`.
    private func handleHostRequest(_ message: [String: Any]) {
        guard let id = message["id"] as? String, let name = message["name"] as? String else { return }
        let params = message["params"] as? [String: Any] ?? [:]
        guard let handler = requestHandlers[name] else {
            reply(id: id, ok: false, error: ["code": "UNKNOWN_REQUEST", "message": "no handler for \"\(name)\""])
            return
        }
        Task { @MainActor in
            do {
                reply(id: id, ok: true, result: try await handler(params))
            } catch {
                reply(id: id, ok: false, error: ["code": "REQUEST_FAILED", "message": "\(error)"])
            }
        }
    }

    /// Send a reply to a host request back to the editor via `window.tiptapBridge.handleReply`.
    /// iOS only sends replies; it never receives a `hostReply`.
    private func reply(id: String, ok: Bool, result: Any? = nil, error: [String: Any]? = nil) {
        var payload: [String: Any] = ["type": "hostReply", "id": id, "ok": ok]
        if let result { payload["result"] = result }
        if let error { payload["error"] = error }
        webView?.evaluateJavaScript(Self.bridgeCallJS("handleReply", payload))
    }

    // MARK: Outbound (host -> editor)

    /// Send a command and await its `id`-correlated response. Returns the response `result`
    /// (any JSON value, possibly nil); throws `TiptapError` if the editor reports failure.
    @discardableResult
    private func send(_ name: String, params: [String: Any]? = nil) async throws -> Any? {
        let id = "\(nextId)"
        nextId += 1

        var command: [String: Any] = ["type": "command", "id": id, "name": name]
        if let params { command["params"] = params }

        let js = Self.bridgeCallJS("handleCommand", command)
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            webView?.evaluateJavaScript(js) { [weak self] _, error in
                // A JS evaluation error means the editor never received the command, so the
                // id-correlated response will never arrive: fail the pending call now.
                guard let error else { return }
                self?.pending.removeValue(forKey: id)?.resume(throwing: error)
            }
        }
    }

    /// Build an inbound bridge call `window.tiptapBridge.<method>(<escaped json>)`.
    ///
    /// The payload is encoded twice: once to a JSON string, then again as a JSON string literal so
    /// quotes/backslashes are escaped for embedding in JavaScript source. This mirrors the Flutter
    /// host's `jsonEncode(jsonEncode(...))`, and serves both `handleCommand` (outbound commands)
    /// and `handleReply` (host-request replies).
    private static func bridgeCallJS(_ method: String, _ payload: [String: Any]) -> String {
        guard
            let inner = try? JSONSerialization.data(withJSONObject: payload),
            let innerString = String(data: inner, encoding: .utf8),
            let literal = try? JSONSerialization.data(withJSONObject: innerString, options: .fragmentsAllowed),
            let literalString = String(data: literal, encoding: .utf8)
        else { return "" }
        return "window.tiptapBridge.\(method)(\(literalString))"
    }

    // MARK: Commands

    /// Create the editor. Must be the first command sent.
    func initEditor() async throws { try await send("init") }

    /// Run any Tiptap command by name. `args` are positional and spread into the command.
    func exec(_ command: String, _ args: [Any]? = nil) async throws {
        var params: [String: Any] = ["command": command]
        if let args { params["args"] = args }
        try await send("exec", params: params)
    }

    /// Fetch the document as ProseMirror JSON.
    func getJSON() async throws -> Any? { try await send("getJSON") }

    /// Fetch the document as an HTML string.
    func getHTML() async throws -> Any? { try await send("getHTML") }

    /// Start receiving the named editor event on `lastEvent`.
    func subscribe(_ event: String) async throws { try await send("subscribe", params: ["event": event]) }

    /// Stop receiving the named editor event.
    func unsubscribe(_ event: String) async throws { try await send("unsubscribe", params: ["event": event]) }
}
