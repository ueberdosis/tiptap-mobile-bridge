/**
 * Tiptap Mobile Bridge protocol.
 *
 * The native host and the editor (running inside a webview) communicate purely
 * through JSON messages. Commands flow host -> editor and are correlated to a
 * response by `id`; events flow editor -> host and carry no `id` (no reply).
 *
 * The transport is platform-agnostic — this contract is identical on iOS,
 * Android, Flutter, and the browser; only the carrier of the JSON differs.
 */

/** A command sent from the native host to the editor. */
export type Command = {
  type: 'command'
  /** Correlation id; the matching response echoes it back. */
  id: string
  /** Command name: `init`, `exec`, `getJSON`, `getHTML`, `setContent`, `setTextSelection`, `focus`, `subscribe`, `unsubscribe`. */
  name: string
  params?: Record<string, unknown>
}

/** Params for the generic `exec` command. */
export type ExecParams = {
  /** Tiptap command name to run, e.g. `toggleBold`, `toggleHeading`, `setTextAlign`. */
  command: string
  /**
   * Positional arguments spread into the command. One generic path serves both
   * object-arg commands (`[{ level: 1 }]` -> `toggleHeading`) and scalar-arg ones
   * (`['left']` -> `setTextAlign`), since Tiptap command signatures are not uniform.
   */
  args?: unknown[]
}

/** A reply to a command, correlated by `id`. Carries either `result` or `error`. */
export type Response = {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

/** Whether a command can run, and whether its mark/node is active at the selection. */
export type CommandState = { canExec: boolean; isActive: boolean }

/** The current selection as ProseMirror document positions. */
export type SelectionState = { from: number; to: number; empty: boolean }

/**
 * An asynchronous, one-way notification from the editor to the host (no reply). The four named
 * events below are always emitted. Any other Tiptap editor event (`focus`, `blur`, `update`,
 * `selectionUpdate`, `transaction`, `paste`, `drop`, `destroy`, `contentError`) is delivered as a
 * generic event once the host sends a `subscribe` command — its payload is a JSON projection
 * (raw Tiptap payloads hold live Editor/Transaction objects that can't cross the bridge).
 */
export type EditorEvent =
  | { type: 'event'; name: 'ready'; payload: Record<string, never> }
  | {
      type: 'event'
      name: 'schemaReady'
      payload: { nodes: string[]; marks: string[]; commands: string[] }
    }
  | {
      type: 'event'
      name: 'selectionChanged'
      payload: { selection: SelectionState; commandStates: Record<string, CommandState> }
    }
  | { type: 'event'; name: 'contentChanged'; payload: Record<string, never> }
  | { type: 'event'; name: string; payload?: Record<string, unknown> }

/** Params for `subscribe` / `unsubscribe`: the Tiptap editor event name to start/stop receiving. */
export type SubscribeParams = { event: string }

/** Anything the editor sends outbound to the host. */
export type OutboundMessage = Response | EditorEvent
