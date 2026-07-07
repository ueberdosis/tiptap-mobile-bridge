import type { RefObject } from 'react';

/// Whether a command can run, and whether its mark/node is active at the selection.
/// Mirrors the `CommandState` carried in the `selectionChanged` event payload.
export type CommandState = { canExec: boolean; isActive: boolean };

/// A generic editor event forwarded over the bridge. `name` is the event name
/// (`ready`, `selectionChanged`, `focus`, `blur`, ...); `payload` is its JSON projection.
export type TiptapEvent = { name: string; payload: Record<string, unknown> };

/// A failed command response, surfaced as a rejected promise to the awaiting caller.
export class TiptapError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'TiptapError';
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RequestHandler = (params: Record<string, unknown>) => Promise<unknown>;

/// The one WebView capability the bridge needs: running JS in the page (react-native-webview's
/// `injectJavaScript`). Kept structural so the bridge stays decoupled from the webview's types.
type WebViewHandle = { injectJavaScript: (script: string) => void };

/// How long a command waits for its id-correlated response before rejecting. `react-native-webview`'s
/// `injectJavaScript` returns no result and no error (unlike Flutter/iOS `evaluateJavaScript`), so a
/// lost inbound command cannot fail fast; this timeout is the equivalent guarantee that a caller
/// never hangs. Generous, because every command responds synchronously in the editor.
const COMMAND_TIMEOUT_MS = 10_000;

/// Build an inbound bridge call `window.tiptapBridge.<method>(<escaped json>)` for injectJavaScript.
///
/// The payload is JSON-encoded twice — once to a JSON string, then again as a JS string literal so
/// quotes/backslashes survive embedding in JavaScript source. This mirrors the Flutter host's
/// `jsonEncode(jsonEncode(...))` and iOS's double `JSONSerialization`. The trailing `true;` is
/// required by react-native-webview: an injected script that returns nothing can fail silently.
function bridgeCallJS(method: 'handleCommand' | 'handleReply', payload: unknown): string {
  const literal = JSON.stringify(JSON.stringify(payload));
  return `window.tiptapBridge.${method}(${literal}); true;`;
}

/// Drives a Tiptap editor running inside a `react-native-webview` over the JSON protocol.
///
/// Commands are sent to the editor via `window.tiptapBridge.handleCommand` (through the WebView's
/// `injectJavaScript`); events and responses arrive by feeding each `onMessage` payload into
/// {@link handleMessage}. Async commands (e.g. `getJSON`) are correlated to their response by `id`.
///
/// This class is framework-agnostic (plain TypeScript + a WebView ref): it works identically in a
/// bare React Native app and an Expo app. The host UI adapts it to React state via
/// {@link onCommandStates} / {@link onEvent}.
export class TiptapBridge {
  private webviewRef: RefObject<WebViewHandle | null> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  /// Handlers the editor can invoke via a host request, keyed by request name. See {@link onRequest}.
  private readonly requestHandlers = new Map<string, RequestHandler>();

  private commandStatesListener?: (states: Record<string, CommandState>) => void;
  private eventListener?: (event: TiptapEvent) => void;

  /// Wire up the WebView the bridge sends commands into. Inbound messages are delivered separately
  /// by the host, which forwards every `onMessage` payload to {@link handleMessage}.
  attach(ref: RefObject<WebViewHandle | null>): void {
    this.webviewRef = ref;
  }

  /// Latest per-command state (from `selectionChanged`) — drives toolbar active styling.
  onCommandStates(listener: (states: Record<string, CommandState>) => void): void {
    this.commandStatesListener = listener;
  }

  /// Every editor event: the four built-in ones plus any subscribed via {@link subscribe}.
  onEvent(listener: (event: TiptapEvent) => void): void {
    this.eventListener = listener;
  }

  /// Register a handler the editor can invoke via a host request (e.g. `uploadImage`). The handler's
  /// resolved value becomes the reply `result`; a thrown error becomes the reply `error`. One handler
  /// per name: registering an existing name replaces it.
  onRequest(name: string, handler: RequestHandler): void {
    this.requestHandlers.set(name, handler);
  }

  // MARK: Inbound (editor -> host)

  /// Decode and dispatch one inbound message body (the WebView `onMessage` string) from the editor.
  handleMessage(json: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case 'response':
        this.settleResponse(message);
        return;
      case 'event':
        this.handleEvent(message);
        return;
      case 'hostRequest':
        void this.handleHostRequest(message);
        return;
      default:
        return;
    }
  }

  private settleResponse(message: Record<string, unknown>): void {
    const id = message.id as string;
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    if (message.ok === true) {
      pending.resolve(message.result);
    } else {
      const error = (message.error as { code?: string; message?: string } | undefined) ?? {};
      pending.reject(new TiptapError(error.code ?? 'COMMAND_FAILED', error.message ?? 'command failed'));
    }
  }

  private handleEvent(message: Record<string, unknown>): void {
    const name = (message.name as string) ?? '';
    const payload = (message.payload as Record<string, unknown>) ?? {};
    if (name === 'selectionChanged') {
      const states = (payload.commandStates as Record<string, { canExec?: unknown; isActive?: unknown }>) ?? {};
      const mapped: Record<string, CommandState> = {};
      for (const key of Object.keys(states)) {
        mapped[key] = { canExec: states[key]?.canExec === true, isActive: states[key]?.isActive === true };
      }
      this.commandStatesListener?.(mapped);
    }
    this.eventListener?.({ name, payload });
  }

  // MARK: Host requests (editor -> host -> editor)

  /// Route an inbound host request to its registered handler and reply with the outcome: the
  /// handler's resolved value as `result`, an unknown name or a thrown error as `error`. Mirrors the
  /// Flutter and iOS hosts.
  private async handleHostRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as string;
    const name = message.name as string;
    const params = (message.params as Record<string, unknown>) ?? {};
    const handler = this.requestHandlers.get(name);
    if (!handler) {
      this.reply(id, false, undefined, { code: 'UNKNOWN_REQUEST', message: `no handler for "${name}"` });
      return;
    }
    try {
      this.reply(id, true, await handler(params));
    } catch (error) {
      this.reply(id, false, undefined, { code: 'REQUEST_FAILED', message: String(error) });
    }
  }

  /// Send a reply to a host request back to the editor via `window.tiptapBridge.handleReply`.
  private reply(id: string, ok: boolean, result?: unknown, error?: { code: string; message: string }): void {
    const payload: Record<string, unknown> = { type: 'hostReply', id, ok };
    if (result !== undefined) {
      payload.result = result;
    }
    if (error) {
      payload.error = error;
    }
    this.webviewRef?.current?.injectJavaScript(bridgeCallJS('handleReply', payload));
  }

  // MARK: Outbound (host -> editor)

  /// Send a command and await its `id`-correlated response. Resolves with the response `result`
  /// (any JSON value, possibly undefined); rejects with {@link TiptapError} on failure or timeout.
  private send(name: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = `${this.nextId++}`;
    const command: Record<string, unknown> = { type: 'command', id, name };
    if (params) {
      command.params = params;
    }
    return new Promise<unknown>((resolve, reject) => {
      const webview = this.webviewRef?.current;
      if (!webview) {
        // No webview attached: fail fast instead of leaving the caller awaiting forever.
        reject(new TiptapError('NO_WEBVIEW', 'bridge is not attached to a webview'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TiptapError('TIMEOUT', `command timed out: ${name} (${id})`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        webview.injectJavaScript(bridgeCallJS('handleCommand', command));
      } catch (error) {
        // A synchronous inject failure means the editor never received the command, so its
        // id-correlated response will never arrive: fail the pending call now.
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new TiptapError('INJECT_FAILED', String(error)));
      }
    });
  }

  // MARK: Commands

  /// Create the editor (must be the first command sent). Pass `content` (an HTML string or
  /// ProseMirror JSON) to open a saved document, and `editable: false` for a read-only view; both
  /// are optional and fall back to the web side's defaults.
  init(content?: unknown, editable?: boolean): Promise<unknown> {
    const params: Record<string, unknown> = {};
    if (content !== undefined) {
      params.content = content;
    }
    if (editable !== undefined) {
      params.editable = editable;
    }
    return this.send('init', Object.keys(params).length ? params : undefined);
  }

  /// Run any Tiptap command by name. `args` are positional and spread into the command.
  exec(command: string, args?: unknown[]): Promise<unknown> {
    return this.send('exec', args ? { command, args } : { command });
  }

  /// Fetch the document as ProseMirror JSON.
  getJSON(): Promise<unknown> {
    return this.send('getJSON');
  }

  /// Fetch the document as an HTML string.
  getHTML(): Promise<unknown> {
    return this.send('getHTML');
  }

  /// Start receiving the named Tiptap editor event on {@link onEvent}.
  subscribe(event: string): Promise<unknown> {
    return this.send('subscribe', { event });
  }

  /// Stop receiving the named Tiptap editor event.
  unsubscribe(event: string): Promise<unknown> {
    return this.send('unsubscribe', { event });
  }
}
