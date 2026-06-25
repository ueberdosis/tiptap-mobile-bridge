import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'tiptap_bridge.dart';

void main() => runApp(const TiptapApp());

class TiptapApp extends StatelessWidget {
  const TiptapApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Tiptap Mobile Bridge',
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo)),
      home: const EditorPage(),
    );
  }
}

class EditorPage extends StatefulWidget {
  const EditorPage({super.key});

  @override
  State<EditorPage> createState() => _EditorPageState();
}

class _EditorPageState extends State<EditorPage> {
  final TiptapBridge _bridge = TiptapBridge();

  /// Whether we're currently subscribed to the demo events (focus/blur/update).
  bool _eventsOn = true;

  @override
  void dispose() {
    _bridge.dispose();
    super.dispose();
  }

  /// Toggle the demo event subscriptions, demonstrating subscribe/unsubscribe.
  void _toggleEvents() {
    setState(() => _eventsOn = !_eventsOn);
    for (final event in ['focus', 'blur', 'update']) {
      _eventsOn ? _bridge.subscribe(event) : _bridge.unsubscribe(event);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Tiptap Mobile Bridge'),
        actions: [
          // Demo: pause/resume the event subscriptions (subscribe/unsubscribe).
          IconButton(
            tooltip: _eventsOn ? 'Pause events' : 'Resume events',
            onPressed: _toggleEvents,
            icon: Icon(_eventsOn ? Icons.pause : Icons.play_arrow),
          ),
        ],
        // Demo: the latest editor event received over the bridge. Proves "receive any
        // event" (driven by the subscribe() calls in onLoadStop below).
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(20),
          child: StreamBuilder<TiptapEvent>(
            stream: _bridge.events,
            builder: (context, snapshot) => Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                snapshot.hasData ? 'event: ${snapshot.data!.name}' : 'event: —',
                style: const TextStyle(fontSize: 12),
              ),
            ),
          ),
        ),
      ),
      body: Column(
        children: [
          // Native toolbar — its buttons send commands and reflect editor state,
          // both carried over the JSON bridge. No HTML toolbar is used.
          ValueListenableBuilder<Map<String, CommandState>>(
            valueListenable: _bridge.commandStates,
            builder: (context, states, _) => _Toolbar(bridge: _bridge, states: states),
          ),
          const Divider(height: 1),
          // The editor itself, rendered inside the (visible) webview.
          Expanded(
            child: InAppWebView(
              initialFile: 'assets/editor.html',
              onWebViewCreated: _bridge.attach,
              onLoadStop: (controller, url) async {
                await _bridge.init();
                // Demo subscriptions — drive the AppBar event line above.
                _bridge.subscribe('focus');
                _bridge.subscribe('blur');
                _bridge.subscribe('update');
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// A toolbar button: the bridge `key` to read active state by, the Tiptap command
/// to run, its icon/tooltip, and optional positional command args. Mirrors a web-side
/// `TOOLBAR_COMMANDS` entry (key + command + args).
class _Btn {
  const _Btn(this.key, this.command, this.icon, this.tooltip, [this.args]);

  final String key;
  final String command;
  final IconData icon;
  final String tooltip;

  /// Positional args spread into the command, e.g. `['left']` for setTextAlign,
  /// `[{'level': 1}]` for toggleHeading.
  final List<dynamic>? args;
}

/// Toggle/insert buttons whose `onPressed` is a plain `exec(command, args)`. The
/// `link` button needs a URL prompt, so it is rendered separately below.
const _toolbarButtons = <_Btn>[
  _Btn('bold', 'toggleBold', Icons.format_bold, 'Bold'),
  _Btn('italic', 'toggleItalic', Icons.format_italic, 'Italic'),
  _Btn('underline', 'toggleUnderline', Icons.format_underlined, 'Underline'),
  _Btn('strike', 'toggleStrike', Icons.format_strikethrough, 'Strikethrough'),
  _Btn('highlight', 'toggleHighlight', Icons.highlight, 'Highlight'),
  _Btn('h1', 'toggleHeading', Icons.looks_one, 'Heading 1', [{'level': 1}]),
  _Btn('h2', 'toggleHeading', Icons.looks_two, 'Heading 2', [{'level': 2}]),
  _Btn('bulletList', 'toggleBulletList', Icons.format_list_bulleted, 'Bullet list'),
  _Btn('taskList', 'toggleTaskList', Icons.checklist, 'Task list'),
  _Btn('alignLeft', 'setTextAlign', Icons.format_align_left, 'Align left', ['left']),
  _Btn('alignCenter', 'setTextAlign', Icons.format_align_center, 'Align center', ['center']),
  _Btn('alignRight', 'setTextAlign', Icons.format_align_right, 'Align right', ['right']),
  _Btn('table', 'insertTable', Icons.grid_on, 'Insert table', [{'rows': 3, 'cols': 3, 'withHeaderRow': true}]),
];

class _Toolbar extends StatelessWidget {
  const _Toolbar({required this.bridge, required this.states});

  final TiptapBridge bridge;
  final Map<String, CommandState> states;

  bool _isActive(String key) => states[key]?.isActive ?? false;

  /// Prompt for a URL, then apply it as a link over the bridge.
  Future<void> _promptLink(BuildContext context) async {
    final controller = TextEditingController();
    final href = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add link'),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(hintText: 'https://example.com'),
          onSubmitted: (value) => Navigator.pop(ctx, value),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, controller.text), child: const Text('Add')),
        ],
      ),
    );
    if (href == null || href.isEmpty) return;
    await bridge.exec('setLink', [{'href': href}]);
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          for (final button in _toolbarButtons)
            IconButton(
              tooltip: button.tooltip,
              isSelected: _isActive(button.key),
              onPressed: () => bridge.exec(button.command, button.args),
              icon: Icon(button.icon),
            ),
          IconButton(
            tooltip: 'Link',
            isSelected: _isActive('link'),
            onPressed: () => _promptLink(context),
            icon: const Icon(Icons.link),
          ),
          const SizedBox(width: 8),
          IconButton(
            tooltip: 'Get JSON',
            onPressed: () async {
              final json = await bridge.getJson();
              if (!context.mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(json.toString(), maxLines: 4)),
              );
            },
            icon: const Icon(Icons.data_object),
          ),
          IconButton(
            tooltip: 'Get HTML',
            onPressed: () async {
              final html = await bridge.getHtml();
              if (!context.mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(html.toString(), maxLines: 4)),
              );
            },
            icon: const Icon(Icons.code),
          ),
        ],
      ),
    );
  }
}
