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
  /** Command name, e.g. `init`, `exec`, `getJSON`, `setContent`, `setTextSelection`, `focus`. */
  name: string
  params?: Record<string, unknown>
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

/** An asynchronous, one-way notification from the editor to the host (no reply). */
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

/** Anything the editor sends outbound to the host. */
export type OutboundMessage = Response | EditorEvent
