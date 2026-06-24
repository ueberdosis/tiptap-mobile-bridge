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

/// Drives a Tiptap editor running inside an [InAppWebView] over the JSON protocol.
///
/// Commands are sent to the editor via `window.tiptapBridge.handleCommand`;
/// events and responses arrive through the `tiptapBridge` JavaScript handler.
/// Async commands (e.g. getJSON) are correlated to their response by id.
class TiptapBridge {
  InAppWebViewController? _controller;
  int _nextId = 1;
  final Map<String, Completer<Object?>> _pending = {};

  /// Latest per-command state (from selectionChanged); drives toolbar buttons.
  final ValueNotifier<Map<String, CommandState>> commandStates = ValueNotifier({});

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
    } else if (type == 'event' && msg['name'] == 'selectionChanged') {
      final states = msg['payload']['commandStates'] as Map<String, dynamic>;
      commandStates.value = states.map(
        (key, value) => MapEntry(
          key,
          CommandState(canExec: value['canExec'] == true, isActive: value['isActive'] == true),
        ),
      );
    }
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

  void dispose() => commandStates.dispose();
}
