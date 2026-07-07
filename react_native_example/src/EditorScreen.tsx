import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {launchImageLibrary} from 'react-native-image-picker';
import {EditorWebView} from './EditorWebView';
import {TiptapBridge, type CommandState} from './TiptapBridge';

/// A toolbar button's wiring: the bridge `key` to read active state by, the Tiptap `command` to run
/// via `exec`, its label, and optional positional args. Mirrors a web-side `TOOLBAR_COMMANDS` entry.
type Tool = {key: string; command: string; label: string; args?: unknown[]};

/// Toggle/insert buttons whose press is a plain `exec(command, args)`. `link` needs a URL prompt, so
/// it is rendered separately. Labels are text — React Native ships no icon set (unlike Flutter's
/// Material icons / iOS SF Symbols), so text avoids a native icon dependency.
const TOOLBAR: Tool[] = [
  {key: 'bold', command: 'toggleBold', label: 'B'},
  {key: 'italic', command: 'toggleItalic', label: 'I'},
  {key: 'underline', command: 'toggleUnderline', label: 'U'},
  {key: 'strike', command: 'toggleStrike', label: 'S'},
  {key: 'highlight', command: 'toggleHighlight', label: 'HL'},
  {key: 'h1', command: 'toggleHeading', label: 'H1', args: [{level: 1}]},
  {key: 'h2', command: 'toggleHeading', label: 'H2', args: [{level: 2}]},
  {key: 'bulletList', command: 'toggleBulletList', label: 'List'},
  {key: 'taskList', command: 'toggleTaskList', label: 'Tasks'},
  {key: 'alignLeft', command: 'setTextAlign', label: 'Left', args: ['left']},
  {key: 'alignCenter', command: 'setTextAlign', label: 'Center', args: ['center']},
  {key: 'alignRight', command: 'setTextAlign', label: 'Right', args: ['right']},
  {key: 'table', command: 'insertTable', label: 'Table', args: [{rows: 3, cols: 3, withHeaderRow: true}]},
];

/// Render a response value for display: HTML comes back as a string; JSON (a ProseMirror document)
/// is pretty-printed.
function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/// Swallow a fire-and-forget command's rejection (e.g. a timeout) so it doesn't surface as an
/// unhandled promise rejection; toolbar presses don't await their result.
function runSafely(promise: Promise<unknown>): void {
  promise.catch(error => console.warn('[tiptap]', error));
}

/// The single screen: a native toolbar over the editor webview. The toolbar's buttons send `exec`
/// commands and reflect active state, both carried over the JSON bridge; the editor renders inside
/// the webview below. Mirrors the Flutter and iOS reference apps.
export function EditorScreen() {
  const bridge = useRef(new TiptapBridge()).current;
  const [commandStates, setCommandStates] = useState<Record<string, CommandState>>({});
  const [lastEvent, setLastEvent] = useState('(none)');

  const [linkVisible, setLinkVisible] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [content, setContent] = useState<{title: string; body: string} | null>(null);

  useEffect(() => {
    bridge.onCommandStates(setCommandStates);
    bridge.onEvent(event => setLastEvent(event.name));
    // Answer the editor's uploadImage host request with a placeholder URL (no real backend), the
    // same as the Flutter and iOS apps. A real host would upload the data URL and return its URL.
    bridge.onRequest('uploadImage', async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 1000));
      return 'https://picsum.photos/400';
    });
  }, [bridge]);

  /// Initialize the editor once the bridge is ready, then subscribe to focus/blur/update so the
  /// header event line lights up as the user interacts. Mirrors the Flutter/iOS onReady hooks.
  const onReady = useCallback(async () => {
    try {
      await bridge.init();
      await bridge.subscribe('focus');
      await bridge.subscribe('blur');
      await bridge.subscribe('update');
    } catch (error) {
      console.warn('[tiptap] init failed', error);
    }
  }, [bridge]);

  const applyLink = useCallback(async () => {
    const href = linkText.trim();
    setLinkVisible(false);
    setLinkText('');
    if (!href) {
      return;
    }
    try {
      await bridge.exec('setLink', [{href}]);
    } catch (error) {
      console.warn('[tiptap]', error);
    }
  }, [bridge, linkText]);

  /// Open the native gallery picker, then insert the chosen image over the bridge as a data URL.
  const insertImage = useCallback(async () => {
    try {
      const result = await launchImageLibrary({mediaType: 'photo', includeBase64: true, selectionLimit: 1});
      if (result.didCancel) {
        return;
      }
      const asset = result.assets?.[0];
      if (!asset?.base64) {
        return;
      }
      const dataUrl = `data:${asset.type ?? 'image/jpeg'};base64,${asset.base64}`;
      await bridge.exec('setImage', [{src: dataUrl}]);
    } catch (error) {
      console.warn('[tiptap]', error);
    }
  }, [bridge]);

  const fetchContent = useCallback(async (title: string, operation: () => Promise<unknown>) => {
    try {
      setContent({title, body: stringify(await operation())});
    } catch (error) {
      setContent({title: `${title} failed`, body: String(error)});
    }
  }, []);

  const isActive = (key: string) => commandStates[key]?.isActive === true;

  return (
    <SafeAreaView style={styles.root} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Tiptap Mobile Bridge</Text>
        {/* The latest editor event received over the bridge (from the subscribe() calls in
            onReady); proves "receive events" end to end, mirroring the iOS header. */}
        <Text style={styles.event}>event: {lastEvent}</Text>
      </View>
      <View style={styles.separator} />

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.toolbarScroll}
        contentContainerStyle={styles.toolbar}>
        {TOOLBAR.map(tool => (
          <ToolbarButton
            key={tool.key}
            label={tool.label}
            active={isActive(tool.key)}
            onPress={() => runSafely(bridge.exec(tool.command, tool.args))}
          />
        ))}
        <ToolbarButton label="Link" active={isActive('link')} onPress={() => setLinkVisible(true)} />
        <View style={styles.divider} />
        <ToolbarButton label="JSON" onPress={() => fetchContent('getJSON', () => bridge.getJSON())} />
        <ToolbarButton label="HTML" onPress={() => fetchContent('getHTML', () => bridge.getHTML())} />
        <ToolbarButton label="Image" onPress={insertImage} />
      </ScrollView>

      <View style={styles.separator} />

      <EditorWebView bridge={bridge} onReady={onReady} />

      {/* Link prompt: the native counterpart to Flutter's _promptLink dialog / iOS's link alert. */}
      <Modal
        visible={linkVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLinkVisible(false)}>
        <View style={styles.modalScrim}>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Add link</Text>
            <TextInput
              style={styles.input}
              placeholder="https://example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              autoFocus
              value={linkText}
              onChangeText={setLinkText}
              onSubmitEditing={applyLink}
            />
            <View style={styles.cardActions}>
              <TouchableOpacity
                onPress={() => {
                  setLinkVisible(false);
                  setLinkText('');
                }}>
                <Text style={styles.cardAction}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={applyLink}>
                <Text style={[styles.cardAction, styles.cardActionPrimary]}>Add</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Get JSON / Get HTML result, shown in a sheet (mirrors iOS's ContentSheet). */}
      <Modal
        visible={content !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setContent(null)}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>{content?.title}</Text>
            <TouchableOpacity onPress={() => setContent(null)}>
              <Text style={styles.cardActionPrimary}>Done</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.separator} />
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <Text style={styles.mono} selectable>
              {content?.body}
            </Text>
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function ToolbarButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={[styles.button, active ? styles.buttonActive : null]} onPress={onPress}>
      <Text style={[styles.buttonLabel, active ? styles.buttonLabelActive : null]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#fff'},
  sheet: {flex: 1, backgroundColor: '#fff'},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  title: {fontSize: 16, fontWeight: '600', color: '#1a1a1a'},
  event: {fontSize: 12, color: '#6b7280', fontFamily: 'Menlo'},
  // A horizontal ScrollView in a flex column otherwise grows to fill the vertical space; flexGrow: 0
  // keeps the toolbar hugging its content height so the webview below gets the rest.
  toolbarScroll: {flexGrow: 0},
  toolbar: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8},
  divider: {width: 1, height: 24, backgroundColor: '#e5e7eb', marginHorizontal: 4},
  separator: {height: 1, backgroundColor: '#e5e7eb'},
  button: {
    minWidth: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#fff',
    alignItems: 'center',
  },
  buttonActive: {backgroundColor: '#1a1a1a', borderColor: '#1a1a1a'},
  buttonLabel: {fontSize: 14, color: '#1a1a1a'},
  buttonLabelActive: {color: '#fff'},
  modalScrim: {flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 24},
  card: {backgroundColor: '#fff', borderRadius: 14, padding: 20},
  cardTitle: {fontSize: 17, fontWeight: '600', marginBottom: 12, color: '#1a1a1a'},
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  cardActions: {flexDirection: 'row', justifyContent: 'flex-end', gap: 20, marginTop: 16},
  cardAction: {fontSize: 16, color: '#6b7280'},
  cardActionPrimary: {color: '#2563eb', fontWeight: '600'},
  sheetBody: {padding: 16},
  mono: {fontFamily: 'Menlo', fontSize: 12, color: '#1a1a1a'},
});
