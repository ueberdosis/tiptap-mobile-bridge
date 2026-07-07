import React, {useEffect, useMemo, useRef} from 'react';
import {StyleSheet} from 'react-native';
import {WebView as RNWebView, type WebViewMessageEvent, type WebViewProps} from 'react-native-webview';
import editorHtml from '../editor.html';
import type {TiptapBridge} from './TiptapBridge';

type WebViewRef = InstanceType<typeof RNWebView>;

// react-native-webview's public types declare `class WebView<P = undefined> extends
// Component<WebViewProps & P>`; with P = undefined, `WebViewProps & undefined` collapses to `never`
// under @types/react 19, so JSX rejects every prop. Re-type it to its real props — the runtime
// component (a forwardRef) is correct; this only papers over an upstream typing quirk.
const WebView = RNWebView as unknown as React.ForwardRefExoticComponent<
  WebViewProps & React.RefAttributes<WebViewRef>
>;

/// Host-only readiness signal (outside the wire protocol): the injected probe posts it once the
/// editor's inbound bridge exists, so the host knows when it can send `init`.
const BRIDGE_READY_MESSAGE = '{"type":"__bridgeReady"}';

/// Injected once after the page loads: poll until the editor's inbound bridge
/// (`window.tiptapBridge`) is installed, then post the readiness signal. The editor bundle is an ES
/// module, so the bridge may not exist the instant the page finishes loading; this absorbs that gap
/// (the same reason the iOS host polls in `waitForBridge`). react-native-webview requires an
/// injected script to end with `true;` or it can fail silently.
const BRIDGE_READY_PROBE = `
(function () {
  var attempts = 0;
  var timer = setInterval(function () {
    if (window.tiptapBridge && window.tiptapBridge.handleCommand) {
      clearInterval(timer);
      window.ReactNativeWebView.postMessage('${BRIDGE_READY_MESSAGE}');
    } else if (++attempts > 100) {
      // Give up after ~3s but signal anyway, so the host attempts init and a genuine failure
      // surfaces (its command times out and is logged) rather than hanging silently — the same
      // "fire anyway" fallback the iOS and Android hosts use.
      clearInterval(timer);
      window.ReactNativeWebView.postMessage('${BRIDGE_READY_MESSAGE}');
    }
  }, 30);
})();
true;
`;

type Props = {
  bridge: TiptapBridge;
  onReady: () => void;
};

/// A `WebView` that hosts the bundled Tiptap editor and wires it to a {@link TiptapBridge}.
///
/// It loads `editor.html` inline (offline, no server — an inline HTML source requires
/// `originWhitelist={['*']}`), forwards every editor message into the bridge, and fires `onReady`
/// once the inbound bridge is installed, which is when the host should send `init`.
export function EditorWebView({bridge, onReady}: Props) {
  const ref = useRef<WebViewRef>(null);

  useEffect(() => {
    bridge.attach(ref);
  }, [bridge]);

  // Stable source so the (large) inline HTML is not reloaded on every render.
  const source = useMemo(() => ({html: editorHtml}), []);

  const onMessage = (event: WebViewMessageEvent) => {
    const data = event.nativeEvent.data;
    if (data === BRIDGE_READY_MESSAGE) {
      onReady();
      return;
    }
    bridge.handleMessage(data);
  };

  return (
    <WebView
      ref={ref}
      source={source}
      originWhitelist={['*']}
      injectedJavaScript={BRIDGE_READY_PROBE}
      onMessage={onMessage}
      keyboardDisplayRequiresUserAction={false}
      style={styles.webview}
    />
  );
}

const styles = StyleSheet.create({
  webview: {flex: 1},
});
