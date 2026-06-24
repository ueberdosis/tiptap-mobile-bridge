# Tiptap Mobile Bridge — Protocol

The native host (Flutter / iOS / Android / a browser tab) and a Tiptap editor running
inside a webview communicate purely through **JSON messages**. This document is the wire
contract; it is identical on every platform — only the carrier of the JSON differs (see
[GUIDE.md](./GUIDE.md#transport-per-platform)).

Source of truth: [`web/src/protocol.ts`](./web/src/protocol.ts) (types) and
[`web/src/main.ts`](./web/src/main.ts) (command/event behaviour).

## Model

- **Commands** flow **host → editor**. Each carries a unique `id`; the editor replies with
  exactly one **response** echoing that `id`. This is how an async result (e.g. `getJSON`)
  is correlated to its request — the correlation lives in the message, not in the transport,
  which is what keeps the protocol carrier-agnostic.
- **Events** flow **editor → host**. They carry no `id` and get no reply — they are
  fire-and-forget notifications (selection moved, content changed, editor ready).

```
host ──── command {id} ───────────────▶ editor
host ◀─── response {id, ok, …} ──────── editor      (one per command)
host ◀─── event {name, payload} ─────── editor      (unsolicited, no id)
```

## Envelopes

```ts
type Command = {
  type: 'command'
  id: string                         // correlation id; the response echoes it
  name: string                       // init | exec | getJSON | setContent | setTextSelection | focus
  params?: Record<string, unknown>
}

type Response = {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown                   // present when ok = true (may be omitted if there is no value)
  error?: { code: string; message: string } // present when ok = false
}

type EditorEvent =
  | { type: 'event'; name: 'ready';            payload: {} }
  | { type: 'event'; name: 'schemaReady';      payload: { nodes: string[]; marks: string[]; commands: string[] } }
  | { type: 'event'; name: 'selectionChanged'; payload: { selection: SelectionState; commandStates: Record<string, CommandState> } }
  | { type: 'event'; name: 'contentChanged';   payload: {} }

type SelectionState = { from: number; to: number; empty: boolean } // ProseMirror positions
type CommandState   = { canExec: boolean; isActive: boolean }
```

## Commands (host → editor)

| Command            | `params`                                  | `result` on success      |
| ------------------ | ----------------------------------------- | ------------------------ |
| `init`             | `{ content?, editable? }`                 | — (also emits 3 events)  |
| `exec`             | `{ command, args? }`                      | `{ executed: boolean }`  |
| `getJSON`          | —                                         | ProseMirror document JSON|
| `setContent`       | `{ content }`                             | —                        |
| `setTextSelection` | `{ from, to? }`                           | —                        |
| `focus`            | `{ position? }`                           | —                        |

**`init`** — create the editor. `content` is an HTML string or ProseMirror JSON
(default `"<p>Hello from Tiptap 👋</p>"`); `editable` defaults to `true`. On success it
emits, in order, `schemaReady` → `ready` → `selectionChanged`, then responds `ok`. Must be
the first command; sending it twice fails with `ALREADY_INITIALIZED`.

**`exec`** — the generic escape hatch: run *any* Tiptap command by name. The editor runs
`editor.chain().focus()[command](args?).run()`, so it focuses first, then dispatches.
`result.executed` is the boolean returned by `.run()` (i.e. whether the command applied).
Unknown names fail with `UNKNOWN_COMMAND`.

```json
{ "type": "command", "id": "7", "name": "exec",
  "params": { "command": "toggleHeading", "args": { "level": 2 } } }
```

**`getJSON`** — return the full document as ProseMirror JSON. Pair it with the
`contentChanged` event: that event is only a signal; you fetch the content here, on demand.

**`setContent`** — replace the document. `content` is passed to `editor.commands.setContent`
(HTML string or ProseMirror JSON).

**`setTextSelection`** — move the selection. `{ from }` collapses the caret at `from`;
`{ from, to }` selects a range.

**`focus`** — focus the editor. Optional `position`: `'start' | 'end' | 'all'`.

## Events (editor → host)

**`ready`** — `payload: {}`. The editor exists and can accept commands beyond `init`.

**`schemaReady`** — `payload: { nodes, marks, commands }`. Discovery: the node/mark names in
the active schema and every command name available to `exec`. Lets a host build UI without
hard-coding what the editor supports.

**`selectionChanged`** — `payload: { selection, commandStates }`. The cheap, high-frequency
channel, **debounced ~10 ms**. `selection` is `{ from, to, empty }`. `commandStates` maps a
command name to `{ canExec, isActive }` and drives toolbar button enabled/active styling.
It contains **only the commands the toolbar needs**, not every command — see the
[`can()` side-effect gotcha](./GUIDE.md#gotcha-probing-cans-side-effects).

**`contentChanged`** — `payload: {}`. A bare signal that the document changed. The content
itself is **not** pushed (it could be large and fires on every keystroke); fetch it with
`getJSON` when you actually need it.

## Error codes

| `error.code`          | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `ALREADY_INITIALIZED` | `init` sent when the editor already exists.                    |
| `NOT_INITIALIZED`     | Any command other than `init` arrived before `init`.           |
| `UNKNOWN_COMMAND`     | `exec` with an unknown command name, or an unknown command.    |
| `COMMAND_FAILED`      | The handler threw while applying the command (`message` = why).|

```json
{ "type": "response", "id": "7", "ok": false,
  "error": { "code": "UNKNOWN_COMMAND", "message": "no such command: toggleMagic" } }
```

## Lifecycle

```
1. Host loads the webview; the editor registers window.tiptapBridge.handleCommand.
2. Host ──▶ init
3. Host ◀── schemaReady, ready, selectionChanged   (then response ok for init)
4. Host ──▶ exec / getJSON / setContent / …         (each gets one response)
   Host ◀── selectionChanged / contentChanged       (streamed as the user edits)
```

## Transport (summary)

The JSON crosses the boundary through these globals — the host implements the outbound
carrier for its platform and always calls the same inbound entry point:

- **Inbound (host → editor):** `window.tiptapBridge.handleCommand(jsonString)`
- **Outbound (editor → host):** Flutter `flutter_inappwebview.callHandler('tiptapBridge', json)`
  · iOS `webkit.messageHandlers.tiptapBridge.postMessage(json)`
  · Android `AndroidTiptapBridge.postMessage(json)`
  · browser `window.postMessage({ source: 'tiptap-editor', message })`

Platform is auto-detected in [`web/src/bridge.ts`](./web/src/bridge.ts) (order:
flutter → ios → android → browser). Native wiring for each is in
[GUIDE.md](./GUIDE.md#transport-per-platform).
