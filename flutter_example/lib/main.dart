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

  @override
  void dispose() {
    _bridge.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tiptap Mobile Bridge')),
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
              onLoadStop: (controller, url) {
                _bridge.init();
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _Toolbar extends StatelessWidget {
  const _Toolbar({required this.bridge, required this.states});

  final TiptapBridge bridge;
  final Map<String, CommandState> states;

  bool _isActive(String command) => states[command]?.isActive ?? false;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          IconButton(
            tooltip: 'Bold',
            isSelected: _isActive('toggleBold'),
            onPressed: () => bridge.exec('toggleBold'),
            icon: const Icon(Icons.format_bold),
          ),
          IconButton(
            tooltip: 'Italic',
            isSelected: _isActive('toggleItalic'),
            onPressed: () => bridge.exec('toggleItalic'),
            icon: const Icon(Icons.format_italic),
          ),
          IconButton(
            tooltip: 'Bullet list',
            isSelected: _isActive('toggleBulletList'),
            onPressed: () => bridge.exec('toggleBulletList'),
            icon: const Icon(Icons.format_list_bulleted),
          ),
          IconButton(
            tooltip: 'Heading 1',
            isSelected: _isActive('toggleHeading'),
            onPressed: () => bridge.exec('toggleHeading', {'level': 1}),
            icon: const Icon(Icons.title),
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
        ],
      ),
    );
  }
}
