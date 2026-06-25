import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

/// Whether a command can run, and whether its mark/node is active at the selection.
class CommandState {
  const CommandState({required this.canExec, required this.isActive});

  final bool canExec;
  final bool isActive;
}

/// A generic editor event forwarded over the bridge. `name` is the Tiptap event name
/// (e.g. `focus`, `blur`, `update`); `payload` is its JSON projection.
class TiptapEvent {
  const TiptapEvent(this.name, this.payload);

  final String name;
  final Map<String, dynamic> payload;
}

/// Drives a Tiptap editor running inside an [InAppWebView] over the JSON protocol.
///
/// Commands are sent to the editor via `window.tiptapBridge.handleCommand`;
/// events and responses arrive through the `tiptapBridge` JavaScript handler.
/// Async commands (e.g. getJSON) are correlated to their response by id.
class TiptapBridge {
  InAppWebViewController? _controller;
  int _nextId = 1;
  final Map<String, Completer<Object?>> _pending = {};

  /// Handlers the editor can invoke via a host request, keyed by request name. See [onRequest].
  final Map<String, Future<Object?> Function(Map<String, dynamic> params)> _requestHandlers = {};

  /// Latest per-command state (from selectionChanged); drives toolbar buttons.
  final ValueNotifier<Map<String, CommandState>> commandStates = ValueNotifier({});

  final StreamController<TiptapEvent> _events = StreamController<TiptapEvent>.broadcast();

  /// Every editor event the editor sends — the four built-in ones plus any the host
  /// subscribes to via [subscribe]. `selectionChanged` also updates [commandStates].
  Stream<TiptapEvent> get events => _events.stream;

  /// Wire up the webview controller and register the inbound message handler.
  void attach(InAppWebViewController controller) {
    _controller = controller;
    controller.addJavaScriptHandler(
      handlerName: 'tiptapBridge',
      callback: (args) {
        if (args.isEmpty) return;
        final decoded = jsonDecode(args.first as String);
        if (decoded is Map<String, dynamic>) _onMessage(decoded);
      },
    );
  }

  void _onMessage(Map<String, dynamic> msg) {
    final type = msg['type'];
    if (type == 'response') {
      final completer = _pending.remove(msg['id']);
      if (msg['ok'] == true) {
        completer?.complete(msg['result']);
      } else {
        completer?.completeError(msg['error'] ?? 'command failed');
      }
    } else if (type == 'event') {
      final name = msg['name'] as String;
      final payload = (msg['payload'] as Map<String, dynamic>?) ?? const {};
      if (name == 'selectionChanged') {
        final states = payload['commandStates'] as Map<String, dynamic>;
        commandStates.value = states.map(
          (key, value) => MapEntry(
            key,
            CommandState(canExec: value['canExec'] == true, isActive: value['isActive'] == true),
          ),
        );
      }
      _events.add(TiptapEvent(name, payload));
    } else if (type == 'hostRequest') {
      _handleHostRequest(msg);
    }
  }

  /// Route an inbound host request to its registered handler and reply with the outcome:
  /// the handler's resolved value as `result`, an unknown name or thrown error as `error`.
  Future<void> _handleHostRequest(Map<String, dynamic> msg) async {
    final id = msg['id'] as String;
    final name = msg['name'] as String;
    final params = (msg['params'] as Map<String, dynamic>?) ?? const {};
    final handler = _requestHandlers[name];
    if (handler == null) {
      _reply(id, ok: false, error: {'code': 'UNKNOWN_REQUEST', 'message': 'no handler for "$name"'});
      return;
    }
    try {
      final result = await handler(params);
      _reply(id, ok: true, result: result);
    } catch (error) {
      _reply(id, ok: false, error: {'code': 'REQUEST_FAILED', 'message': error.toString()});
    }
  }

  /// Send a reply to a host request back to the editor via `window.tiptapBridge.handleReply`.
  /// The reply JSON is double-encoded into a JS string literal so it survives as an argument
  /// to evaluateJavascript.
  void _reply(String id, {required bool ok, Object? result, Map<String, dynamic>? error}) {
    final reply = <String, dynamic>{'type': 'hostReply', 'id': id, 'ok': ok};
    if (result != null) reply['result'] = result;
    if (error != null) reply['error'] = error;
    final js = 'window.tiptapBridge.handleReply(${jsonEncode(jsonEncode(reply))})';
    _controller?.evaluateJavascript(source: js);
  }

  Future<Object?> _send(String name, {Map<String, dynamic>? params}) {
    final id = '${_nextId++}';
    final completer = Completer<Object?>();
    _pending[id] = completer;
    final command = <String, dynamic>{
      'type': 'command',
      'id': id,
      'name': name,
      if (params != null) 'params': params,
    };
    // Pass the command as a JSON string argument to the editor's inbound handler.
    final js = 'window.tiptapBridge.handleCommand(${jsonEncode(jsonEncode(command))})';
    _controller?.evaluateJavascript(source: js);
    return completer.future;
  }

  Future<void> init() => _send('init');

  Future<void> exec(String command, [List<dynamic>? args]) =>
      _send('exec', params: {'command': command, if (args != null) 'args': args});

  Future<Object?> getJson() => _send('getJSON');

  Future<Object?> getHtml() => _send('getHTML');

  /// Start receiving the named Tiptap editor event on the [events] stream.
  Future<void> subscribe(String event) => _send('subscribe', params: {'event': event});

  /// Stop receiving the named Tiptap editor event.
  Future<void> unsubscribe(String event) => _send('unsubscribe', params: {'event': event});

  /// Register a handler the editor can invoke via a host request (e.g. `uploadImage`). The
  /// handler's resolved value becomes the reply `result`; a thrown error becomes the reply
  /// `error`. One handler per name: registering an existing name replaces it.
  void onRequest(String name, Future<Object?> Function(Map<String, dynamic> params) handler) {
    _requestHandlers[name] = handler;
  }

  void dispose() {
    commandStates.dispose();
    _events.close();
  }
}
