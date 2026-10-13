import 'dart:convert';

import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tiptap_bridge_example/tiptap_bridge.dart';

/// A webview controller that records every script the bridge evaluates and lets a test play the
/// editor by calling the registered `tiptapBridge` handler. Implements only what the bridge uses.
class FakeWebViewController implements InAppWebViewController {
  final List<String> scripts = [];
  JavaScriptHandlerCallback? _handler;

  /// What each `evaluateJavascript` call resolves to; make it throw to simulate a failed eval.
  Future<dynamic> Function(String source) evaluate = (_) async => null;

  @override
  void addJavaScriptHandler({required String handlerName, required JavaScriptHandlerCallback callback}) {
    if (handlerName == 'tiptapBridge') _handler = callback;
  }

  @override
  Future<dynamic> evaluateJavascript({required String source, ContentWorld? contentWorld}) {
    scripts.add(source);
    return evaluate(source);
  }

  /// Send an editor -> host message the way the page's `callHandler('tiptapBridge', json)` does.
  void deliver(Map<String, dynamic> message) => _handler!([jsonEncode(message)]);

  /// The messages passed to `window.tiptapBridge.<method>(...)`, unwrapped from their string literal.
  List<Object?> calls(String method) {
    final prefix = 'window.tiptapBridge.$method(';
    return [
      for (final script in scripts)
        if (script.startsWith(prefix))
          jsonDecode(jsonDecode(script.substring(prefix.length, script.length - 1)) as String),
    ];
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  late FakeWebViewController controller;
  late TiptapBridge bridge;

  setUp(() {
    controller = FakeWebViewController();
    bridge = TiptapBridge()..attach(controller);
  });

  tearDown(() => bridge.dispose());

  group('commands', () {
    test('sends each command to window.tiptapBridge.handleCommand with a fresh id', () {
      bridge.exec('toggleHeading', [{'level': 2}]);
      bridge.getHtml();

      expect(controller.calls('handleCommand'), [
        {'type': 'command', 'id': '1', 'name': 'exec', 'params': {'command': 'toggleHeading', 'args': [{'level': 2}]}},
        {'type': 'command', 'id': '2', 'name': 'getHTML'},
      ]);
    });

    test('escapes the payload so quotes, backslashes and newlines arrive intact', () {
      const content = '<p>"double" \'single\' back\\slash\nnew line </script> ✓</p>';
      bridge.init(content: content, editable: false);

      expect(controller.calls('handleCommand'), [
        {'type': 'command', 'id': '1', 'name': 'init', 'params': {'content': content, 'editable': false}},
      ]);
    });

    test('completes each command with its own response, in any order', () async {
      final json = bridge.getJson();
      final html = bridge.getHtml();

      controller.deliver({'type': 'response', 'id': '2', 'ok': true, 'result': '<p>Hi</p>'});
      controller.deliver({'type': 'response', 'id': '1', 'ok': true, 'result': {'type': 'doc'}});
      expect(await json, {'type': 'doc'});
      expect(await html, '<p>Hi</p>');
    });

    test('fails with a TiptapError carrying the editor error code', () async {
      final result = bridge.exec('toggleMagic');

      controller.deliver({
        'type': 'response',
        'id': '1',
        'ok': false,
        'error': {'code': 'UNKNOWN_COMMAND', 'message': 'no such command: toggleMagic'},
      });
      await expectLater(
        result,
        throwsA(isA<TiptapError>()
            .having((e) => e.code, 'code', 'UNKNOWN_COMMAND')
            .having((e) => e.message, 'message', 'no such command: toggleMagic')),
      );
    });

    test('fails fast with NO_WEBVIEW before a webview is attached', () async {
      final detached = TiptapBridge();
      addTearDown(detached.dispose);

      await expectLater(detached.getHtml(), throwsA(isA<TiptapError>().having((e) => e.code, 'code', 'NO_WEBVIEW')));
    });

    test('fails the pending command when the eval fails, then ignores a late response', () async {
      final evalError = Exception('webview gone');
      controller.evaluate = (_) async => throw evalError;

      await expectLater(bridge.getHtml(), throwsA(same(evalError)));
      expect(() => controller.deliver({'type': 'response', 'id': '1', 'ok': true}), returnsNormally);
    });
  });

  group('waitUntilReady', () {
    test('polls until the inbound bridge is installed', () async {
      final answers = [false, false, true];
      controller.evaluate = (_) async => answers.removeAt(0);

      await bridge.waitUntilReady(interval: Duration.zero);
      expect(controller.scripts, hasLength(3));
    });

    test('returns anyway once the attempts run out', () async {
      controller.evaluate = (_) async => false;

      await bridge.waitUntilReady(attempts: 5, interval: Duration.zero);
      expect(controller.scripts, hasLength(5));
    });
  });

  group('events', () {
    test('turns selectionChanged into commandStates and streams every event', () async {
      final events = <TiptapEvent>[];
      bridge.events.listen(events.add);

      controller.deliver({
        'type': 'event',
        'name': 'selectionChanged',
        'payload': {
          'selection': {'from': 1, 'to': 6, 'empty': false},
          'commandStates': {'bold': {'canExec': true, 'isActive': true}, 'italic': {'canExec': 'yes'}},
        },
      });
      controller.deliver({'type': 'event', 'name': 'focus'});
      await pumpEventQueue();

      final states = bridge.commandStates.value;
      expect(states.keys, ['bold', 'italic']);
      expect([states['bold']!.canExec, states['bold']!.isActive], [true, true]);
      expect([states['italic']!.canExec, states['italic']!.isActive], [false, false]);
      expect(events.map((e) => e.name), ['selectionChanged', 'focus']);
      expect(events.last.payload, isEmpty);
    });
  });

  group('host requests', () {
    test('runs the registered handler and replies through window.tiptapBridge.handleReply', () async {
      Map<String, dynamic>? received;
      bridge.onRequest('uploadImage', (params) async {
        received = params;
        return 'https://cdn.example.com/a.png';
      });

      controller.deliver({'type': 'hostRequest', 'id': 'r1', 'name': 'uploadImage', 'params': {'dataUrl': 'data:,'}});
      await pumpEventQueue();
      expect(received, {'dataUrl': 'data:,'});
      expect(controller.calls('handleReply'), [
        {'type': 'hostReply', 'id': 'r1', 'ok': true, 'result': 'https://cdn.example.com/a.png'},
      ]);
    });

    test('replies with an error for a failing handler or an unknown request name', () async {
      bridge.onRequest('uploadImage', (params) async => throw Exception('offline'));

      controller.deliver({'type': 'hostRequest', 'id': 'r1', 'name': 'uploadImage'});
      controller.deliver({'type': 'hostRequest', 'id': 'r2', 'name': 'pickColor'});
      await pumpEventQueue();
      expect(
        controller.calls('handleReply'),
        unorderedEquals([
          {'type': 'hostReply', 'id': 'r1', 'ok': false, 'error': {'code': 'REQUEST_FAILED', 'message': 'Exception: offline'}},
          {
            'type': 'hostReply',
            'id': 'r2',
            'ok': false,
            'error': {'code': 'UNKNOWN_REQUEST', 'message': 'no handler for "pickColor"'},
          },
        ]),
      );
    });
  });
}
